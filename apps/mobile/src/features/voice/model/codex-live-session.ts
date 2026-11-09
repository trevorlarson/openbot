import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type {
  LiveVoiceEvent,
  LiveVoiceName,
  LiveVoiceSessionResponse,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";

/** The Team connection that starts the call and receives its transcript. */
export interface CodexLiveHost {
  /** A rejected start releases any session whose result is uncertain. */
  start(agentId: string, offer: string, voice?: LiveVoiceName): Promise<LiveVoiceSessionResponse>;
  stop(sessionId: string): Promise<void>;
  /** Closing the connection that started a call also ends a start whose result is still pending. */
  disconnect(): void;
  /** `onUnavailable` runs when the connection that this call needs is gone. */
  subscribe(listener: (event: LiveVoiceEvent) => void, onUnavailable: () => void): () => void;
}

export interface CodexLiveMediaEvents {
  /** Android can report background while the microphone permission dialog is open. */
  onPermissionChange?(asking: boolean): void;
  /** An event that the model sends on its data channel, as JSON text. */
  onMessage(data: string): void;
  /** The microphone ended or the audio connection dropped. */
  onFailure(): void;
}

/** The phone's audio of one call, direct to the model. */
export interface CodexLiveMedia {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  mute(muted: boolean): void;
  /** Off silences the model's reply on the phone only; the model and the agent go on. */
  setReplyAudio(on: boolean): void;
  /** Also releases what arrives after close, such as a microphone that was still being requested. */
  close(): void;
}

export type CodexLivePhase = "idle" | "starting" | "listening" | "thinking" | "speaking" | "ended";

export interface CodexLiveState {
  phase: CodexLivePhase;
  muted: boolean;
  /** The words of the turn that is in progress. */
  caption: string;
  heard: string;
  said: string;
  error: Error | null;
  endReason: "ended" | "failed" | "host-ended" | null;
}

const START_TIMEOUT_MS = 60_000;
const SDP_LIMIT = 65_536;
const CAPTION_LIMIT = 100_000;
/** Ends that arrive before their start response; a host that sends more is not trusted. */
const EARLY_END_LIMIT = 64;

type ConnectedPhase = "listening" | "thinking" | "speaking";

const disconnected = () => new Error(sourceText("error.voice.live.disconnected"));

/**
 * One call attempt. The host starts a Realtime v3 session and the phone's audio goes to it
 * directly. A new attempt after a failure needs a new session, with its own media and subscription.
 */
export function createCodexLiveSession(
  host: CodexLiveHost,
  createMedia: (events: CodexLiveMediaEvents) => CodexLiveMedia,
) {
  let state: CodexLiveState = {
    phase: "idle",
    muted: false,
    caption: "",
    heard: "",
    said: "",
    error: null,
    endReason: null,
  };
  let ended = false;
  let connected = false;
  let phase: ConnectedPhase = "listening";
  let sessionId: string | null = null;
  let startingHost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | null = null;
  let replyTurnId: unknown = null;
  let silencedTurnId: unknown = null;
  let silenceNextReply = false;
  const earlyEnds = new Map<string, string | null>();
  const listeners = new Set<(next: CodexLiveState) => void>();
  const media = createMedia({
    onMessage: handleModelEvent,
    onFailure: () => finish("failed", disconnected()),
  });

  function publish(change: Partial<CodexLiveState>): void {
    state = { ...state, ...change };
    for (const listener of listeners) listener(state);
  }

  function releaseSession(id: string): void {
    void host.stop(id).catch(() => host.disconnect());
  }

  function finish(endReason: NonNullable<CodexLiveState["endReason"]>, error: Error | null = null): void {
    if (ended) return;
    // Closing the media can call back, so the attempt is marked ended before any release.
    ended = true;
    clearTimeout(timer);
    timer = undefined;
    media.close();
    unsubscribe?.();
    unsubscribe = null;
    if (sessionId) releaseSession(sessionId);
    else if (startingHost) host.disconnect();
    sessionId = null;
    earlyEnds.clear();
    publish({ phase: "ended", endReason, error });
  }

  function setPhase(next: ConnectedPhase, change: Partial<CodexLiveState> = {}): void {
    phase = next;
    publish({ ...change, ...(connected ? { phase: next } : {}) });
  }

  function handleHostEvent(event: LiveVoiceEvent): void {
    if (ended) return;
    if (event.sessionId !== sessionId) {
      if (startingHost && event.kind === "ended" && earlyEnds.size < EARLY_END_LIMIT) {
        earlyEnds.set(event.sessionId, event.error);
      }
      return;
    }
    if (event.kind === "ended") {
      sessionId = null;
      finish("host-ended", event.error ? new Error(event.error) : null);
      return;
    }
    const previous = event.role === "user" ? state.heard : state.said;
    const text = (event.final ? event.text : previous + event.text).slice(-CAPTION_LIMIT);
    publish({ ...(event.role === "user" ? { heard: text } : { said: text }), caption: text });
  }

  /** The model's own events decide the phase. Silence never cancels the agent's task. */
  function handleModelEvent(raw: string): void {
    if (ended || state.phase === "idle") return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isDynamicRecord(event) || !isDynamicRecord(event.turn)) return;
    const { turn } = event;
    if (!("id" in turn) || !("role" in turn)) return;
    const created = event.type === "turn.created";
    const done = event.type === "turn.done";
    if (turn.role === "user") {
      if (created) {
        silenceNextReply = false;
        if (silencedTurnId === null) media.setReplyAudio(true);
        setPhase("listening", { heard: "", caption: "" });
      } else if (done && phase !== "speaking") {
        setPhase("thinking");
      }
    } else if (turn.role === "assistant") {
      if (created) {
        replyTurnId = turn.id;
        if (silenceNextReply) {
          silenceNextReply = false;
          silencedTurnId = turn.id;
          return;
        }
        setPhase("speaking", { said: "", caption: "" });
      } else if (done) {
        if (silencedTurnId === turn.id) {
          silencedTurnId = null;
          media.setReplyAudio(true);
        }
        if (replyTurnId === turn.id) {
          replyTurnId = null;
          if (phase === "speaking") setPhase("listening");
        }
      }
    }
  }

  async function connect(agentId: string, voice: LiveVoiceName | undefined): Promise<void> {
    unsubscribe = host.subscribe(handleHostEvent, () => {
      startingHost = false;
      sessionId = null;
      finish("failed", disconnected());
    });
    // A host that was replaced before the call can report that at once.
    if (ended) {
      unsubscribe();
      return;
    }
    const offer = await media.offer();
    if (ended) return;
    if (!offer || offer.length > SDP_LIMIT) throw disconnected();
    startingHost = true;
    let result: LiveVoiceSessionResponse;
    try {
      result = await host.start(agentId, offer, voice);
    } finally {
      // The host adapter cleans up after a rejected or uncertain start.
      startingHost = false;
    }
    if (ended) {
      releaseSession(result.sessionId);
      return;
    }
    // The host can end the call before its start response reaches the phone.
    if (earlyEnds.has(result.sessionId)) {
      const reason = earlyEnds.get(result.sessionId);
      finish("host-ended", reason ? new Error(reason) : null);
      return;
    }
    earlyEnds.clear();
    sessionId = result.sessionId;
    await media.answer(result.sdp);
    if (ended) return;
    clearTimeout(timer);
    timer = undefined;
    connected = true;
    media.mute(state.muted);
    publish({ phase });
  }

  return {
    subscribe(listener: (next: CodexLiveState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(agentId: string, voice?: LiveVoiceName): Promise<void> {
      if (state.phase !== "idle" || ended) return;
      publish({ phase: "starting" });
      timer = setTimeout(() => finish("failed", new Error(sourceText("error.voice.live.timedOut"))), START_TIMEOUT_MS);
      try {
        await connect(agentId, voice);
      } catch (error) {
        finish("failed", error instanceof Error ? error : disconnected());
      }
    },
    toggleMute(): void {
      if (ended) return;
      const muted = !state.muted;
      media.mute(muted);
      publish({ muted });
    },
    /** Silences the reply that is playing, or the next one when the agent still works. */
    interrupt(): void {
      if (ended || !connected || (phase !== "speaking" && phase !== "thinking")) return;
      if (phase === "speaking") silencedTurnId = replyTurnId;
      else silenceNextReply = true;
      media.setReplyAudio(false);
      setPhase("listening");
    },
    end: () => finish("ended"),
    dispose(): void {
      finish("ended");
      listeners.clear();
    },
  };
}

export type CodexLiveSession = ReturnType<typeof createCodexLiveSession>;
