// Checks the phone side of Codex live voice (#mobile-codex-live-voice): the call session
// (`createCodexLiveSession`), the host adapter (`createCodexLiveHosts`) and the live-voice-v1 wire
// contract, from a start to a stop.
//
// It runs the real session and host adapter against a real HTTP server that implements the two
// live-voice-v1 routes with the real request decoders, and that sends the host's own `live-voice`
// events. Only the boundaries that need a phone or OpenAI are replaced: the WebRTC media of the phone
// and the model's data channel, which the test drives with the Realtime v3 events that the session
// reads. It sends nothing outside this computer. It checks:
// 1. A start sends the agent, the offer and the chosen voice, and applies the host's answer.
// 2. The transcript of the host and the turns of the model drive the caption and the phase.
// 3. Silencing a reply mutes the reply only, and the next turn restores it.
// 4. Ending a call stops the host session and releases the media; a call ends when the media fails.
// 5. A host refusal shows its fixed message, other response text stays private, and a malformed
//    answer closes the connection that sent the start.
// 6. A host end that arrives before the start response ends the call, with no stop request.
// 7. A dropped or replaced connection ends its calls, and a host from before cannot start one.
//
// Run: bun run test:mobile-codex-live-voice
// It writes .openbot-build/mobile-codex-live-voice-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  decodeLiveVoiceStartRequest,
  decodeLiveVoiceStopRequest,
  LIVE_VOICE_EVENT,
  LIVE_VOICE_ROUTES,
  type LiveVoiceEvent,
  type LiveVoiceStartRequest,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { createCodexLiveHosts } from "../apps/mobile/src/features/voice/model/codex-live-host";
import { createCodexLiveSession } from "../apps/mobile/src/features/voice/model/codex-live-session";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mobile-codex-live-voice-e2e");
const WAIT_TIMEOUT_MS = 10_000;
const SERVER_ID = "server-a";
const logger = createOpenBotLogger("mobile-codex-live-voice-e2e");
type Session = ReturnType<typeof createCodexLiveSession>;
type SessionState = Parameters<Parameters<Session["subscribe"]>[0]>[0];
type MediaFactory = Parameters<typeof createCodexLiveSession>[1];
type MediaEvents = Parameters<MediaFactory>[0];
type Peer = NonNullable<ReturnType<Parameters<typeof createCodexLiveHosts>[0]>>;

// --- The host: the two live-voice-v1 routes of a real server. ---

const SIGN_IN_REFUSAL = sourceText("error.voice.live.signIn");
const starts: LiveVoiceStartRequest[] = [];
const stops: string[] = [];
let peerDisconnects = 0;
let inFlight = 0;
let completePendingStart: (() => void) | null = null;
let emitHostEvent: (event: LiveVoiceEvent) => void = () => undefined;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === LIVE_VOICE_ROUTES.stop) {
      stops.push(decodeLiveVoiceStopRequest(body));
      send(body.sessionId === "session-stop-fails" ? 500 : 200, {});
      return;
    }
    let start: LiveVoiceStartRequest;
    try {
      start = decodeLiveVoiceStartRequest(body);
    } catch {
      send(400, { error: "The request is not a live voice start." });
      return;
    }
    starts.push(start);
    if (start.agentId === "agent-pending") {
      completePendingStart = () => send(200, { sessionId: "session-pending", sdp: "answer-pending" });
    } else if (start.agentId === "agent-stop-fails") send(200, { sessionId: "session-stop-fails", sdp: "answer-ok" });
    else if (start.agentId === "agent-refused") send(409, { error: SIGN_IN_REFUSAL });
    else if (start.agentId === "agent-private") send(500, { error: "internal failure with a private stack trace" });
    else if (start.agentId === "agent-malformed") send(200, { sessionId: 5 });
    else if (start.agentId === "agent-early") {
      // The host ends the call before the response that tells the phone its session ID.
      emitHostEvent({ type: LIVE_VOICE_EVENT, kind: "ended", sessionId: "session-early", error: null });
      send(200, { sessionId: "session-early", sdp: "answer-early" });
    } else send(200, { sessionId: "session-ok", sdp: "answer-ok" });
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object", "the host listens on a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

const peers: Peer[] = [];
function createPeer(): Peer {
  const peer: Peer = {
    fetchRaw: async (method, path, body) => {
      inFlight += 1;
      try {
        const reply = await fetch(`${baseUrl}${path}`, { method, body: JSON.stringify(body ?? {}) });
        return { status: reply.status, body: await reply.json() };
      } finally {
        inFlight -= 1;
      }
    },
    disconnect: async () => {
      peerDisconnects += 1;
    },
  };
  peers.push(peer);
  return peer;
}
let currentPeer: Peer | null = createPeer();
const hosts = createCodexLiveHosts(() => currentPeer);
emitHostEvent = (event) => hosts.event(SERVER_ID, event);

// --- The phone's media: it records what the session asks of WebRTC. ---

interface MediaRecord {
  offers: number;
  answers: string[];
  muted: boolean[];
  replyAudio: boolean[];
  closed: boolean;
  events: MediaEvents | null;
}

function createFakeMedia() {
  const record: MediaRecord = { offers: 0, answers: [], muted: [], replyAudio: [], closed: false, events: null };
  const factory: MediaFactory = (events) => {
    record.events = events;
    return {
      offer: async () => {
        record.offers += 1;
        return "offer-sdp";
      },
      answer: async (sdp) => {
        record.answers.push(sdp);
      },
      mute: (muted) => {
        record.muted.push(muted);
      },
      setReplyAudio: (on) => {
        record.replyAudio.push(on);
      },
      close: () => {
        record.closed = true;
      },
    };
  };
  return { record, factory };
}

// --- Helpers. ---

async function waitFor(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((next) => setImmediate(next));
  }
}

const openSessions: Session[] = [];

/** One call, started on the host of this server, with the states that it published. */
function openCall(agentId: string, voice?: LiveVoiceStartRequest["voice"]) {
  const media = createFakeMedia();
  const host = hosts.host(SERVER_ID);
  assert.ok(host, "the registry has a host for the current connection");
  const session = createCodexLiveSession(host, media.factory);
  openSessions.push(session);
  const states: SessionState[] = [];
  session.subscribe((state) => states.push(state));
  const started = session.start(agentId, voice);
  return {
    session,
    media: media.record,
    started,
    latest: () => states.at(-1),
    until: (what: string, predicate: (state: SessionState) => boolean) => waitFor(what, () => states.some(predicate)),
  };
}

const modelEvent = (type: "turn.created" | "turn.done", role: "user" | "assistant", id: string) =>
  JSON.stringify({ type, turn: { id, role } });
const transcript = (role: "user" | "assistant", text: string, final: boolean): LiveVoiceEvent => ({
  type: LIVE_VOICE_EVENT,
  kind: "transcript",
  sessionId: "session-ok",
  role,
  text,
  final,
});

/** Ends every call of the last case and lets its requests finish, so they cannot reach the next case. */
async function settle() {
  for (const session of openSessions.splice(0)) session.dispose();
  await waitFor("the requests of the last case", () => inFlight === 0);
}

function reset() {
  starts.length = 0;
  stops.length = 0;
  peerDisconnects = 0;
  peers.length = 0;
  currentPeer = createPeer();
  hosts.invalidate(SERVER_ID);
}

interface CaseResult {
  name: string;
  passed: boolean;
  checks: Record<string, boolean>;
  error?: string;
}

const cases: [string, () => Promise<Record<string, boolean>>][] = [
  [
    "a start sends the agent, offer and voice, and the transcript and model turns drive the call",
    async () => {
      const call = openCall("agent-1", "juniper");
      await call.until("the call listens", (state) => state.phase === "listening");
      const checks: Record<string, boolean> = {
        startRequest:
          starts.length === 1 &&
          starts[0]?.agentId === "agent-1" &&
          starts[0].sdp === "offer-sdp" &&
          starts[0].voice === "juniper",
        answerApplied: call.media.answers.join() === "answer-ok",
      };
      hosts.event(SERVER_ID, transcript("user", "Hello", false));
      hosts.event(SERVER_ID, transcript("user", " there", false));
      await call.until("the partial words join", (state) => state.heard === "Hello there");
      hosts.event(SERVER_ID, transcript("user", "Hello there.", true));
      await call.until("the final words replace them", (state) => state.heard === "Hello there.");
      checks.transcriptJoined = call.latest()?.caption === "Hello there.";
      call.media.events?.onMessage(modelEvent("turn.created", "user", "u1"));
      call.media.events?.onMessage(modelEvent("turn.done", "user", "u1"));
      await call.until("the call thinks", (state) => state.phase === "thinking");
      call.media.events?.onMessage(modelEvent("turn.created", "assistant", "a1"));
      await call.until("the call speaks", (state) => state.phase === "speaking");
      call.media.events?.onMessage(modelEvent("turn.done", "assistant", "a1"));
      await call.until("the call listens again", (state) => state.phase === "listening" && state.heard === "");
      checks.followsTurns = true;
      call.session.dispose();
      return checks;
    },
  ],
  [
    "silencing a reply mutes the reply only and the next turn restores it",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      call.media.events?.onMessage(modelEvent("turn.created", "assistant", "a1"));
      await call.until("the call speaks", (state) => state.phase === "speaking");
      call.session.interrupt();
      const checks: Record<string, boolean> = {
        replyMuted: call.media.replyAudio.at(-1) === false,
        listensAtOnce: call.latest()?.phase === "listening",
        callOpen: !call.media.closed && stops.length === 0,
      };
      call.media.events?.onMessage(modelEvent("turn.done", "assistant", "a1"));
      checks.replyRestored = call.media.replyAudio.at(-1) === true;
      call.session.dispose();
      return checks;
    },
  ],
  [
    "silencing while thinking suppresses one reply and mute leaves the call open",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      call.session.toggleMute();
      const microphoneMuted = call.latest()?.muted === true && call.media.muted.at(-1) === true;
      call.session.toggleMute();
      call.media.events?.onMessage(modelEvent("turn.done", "user", "u1"));
      call.session.interrupt();
      call.media.events?.onMessage(modelEvent("turn.created", "assistant", "a1"));
      const replySuppressed = call.latest()?.phase === "listening" && call.media.replyAudio.at(-1) === false;
      call.media.events?.onMessage(modelEvent("turn.done", "assistant", "a1"));
      const replyRestored = call.media.replyAudio.at(-1) === true;
      call.media.events?.onMessage(modelEvent("turn.created", "assistant", "a2"));
      return {
        microphoneMuted,
        microphoneRestored: call.media.muted.at(-1) === false && call.latest()?.muted === false,
        replySuppressed,
        replyRestored,
        nextReplySpeaks: call.latest()?.phase === "speaking",
        callOpen: !call.media.closed && stops.length === 0,
      };
    },
  ],
  [
    "ending a call stops the host session and releases the media",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      call.session.end();
      await waitFor("the host stop request", () => stops.length === 1);
      return {
        stopped: stops[0] === "session-ok",
        mediaReleased: call.media.closed,
        endedByUser: call.latest()?.endReason === "ended",
      };
    },
  ],
  [
    "the media failing ends the call and releases the host session",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      call.media.events?.onFailure();
      await waitFor("the host stop request", () => stops.length === 1);
      return {
        failed: call.latest()?.endReason === "failed",
        saysDisconnected: call.latest()?.error?.message === sourceText("error.voice.live.disconnected"),
        mediaReleased: call.media.closed,
      };
    },
  ],
  [
    "ending during host startup closes the connection and stops a late session",
    async () => {
      const call = openCall("agent-pending");
      await waitFor("the host receives the pending start", () => completePendingStart !== null);
      call.session.end();
      const closedDuringStart = peerDisconnects === 1 && call.media.closed;
      completePendingStart?.();
      completePendingStart = null;
      await call.started;
      await waitFor("the late session stop", () => stops.includes("session-pending"));
      return {
        closedDuringStart,
        lateSessionStopped: stops.length === 1,
        answerNotApplied: call.media.answers.length === 0,
        staysEnded: call.latest()?.endReason === "ended",
      };
    },
  ],
  [
    "a refused stop closes the owning connection",
    async () => {
      const call = openCall("agent-stop-fails");
      await call.until("the call listens", (state) => state.phase === "listening");
      call.session.end();
      await waitFor("the connection closes after stop fails", () => peerDisconnects === 1);
      return { connectionClosed: true, mediaReleased: call.media.closed, stopped: stops[0] === "session-stop-fails" };
    },
  ],
  [
    "a host refusal shows its fixed message and other response text stays private",
    async () => {
      const refused = openCall("agent-refused");
      await refused.until("the refusal ends the call", (state) => state.phase === "ended");
      const priv = openCall("agent-private");
      await priv.until("the failure ends the call", (state) => state.phase === "ended");
      return {
        refusalShown: refused.latest()?.error?.message === SIGN_IN_REFUSAL,
        privateTextHidden: priv.latest()?.error?.message === sourceText("error.voice.live.disconnected"),
        mediaReleased: refused.media.closed && priv.media.closed,
        noStopForRefusals: stops.length === 0,
      };
    },
  ],
  [
    "a malformed start answer closes the connection that sent the start",
    async () => {
      const call = openCall("agent-malformed");
      await call.until("the answer ends the call", (state) => state.phase === "ended");
      return {
        failed: call.latest()?.endReason === "failed",
        connectionClosed: peerDisconnects === 1,
      };
    },
  ],
  [
    "a host end before the start response ends the call with no stop request",
    async () => {
      const call = openCall("agent-early");
      await call.until("the host end ends the call", (state) => state.phase === "ended");
      await call.started;
      return {
        endedByHost: call.latest()?.endReason === "host-ended",
        noStop: stops.length === 0,
        mediaReleased: call.media.closed,
        answerNotApplied: call.media.answers.length === 0,
      };
    },
  ],
  [
    "a host that ends the call with a reason shows it",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      hosts.event(SERVER_ID, {
        type: LIVE_VOICE_EVENT,
        kind: "ended",
        sessionId: "session-ok",
        error: "The model stopped.",
      });
      await call.until("the host end ends the call", (state) => state.phase === "ended");
      return {
        endedByHost: call.latest()?.endReason === "host-ended",
        reasonShown: call.latest()?.error?.message === "The model stopped.",
        noStop: stops.length === 0,
      };
    },
  ],
  [
    "a dropped connection ends its calls and a host from before cannot start one",
    async () => {
      const call = openCall("agent-1");
      await call.until("the call listens", (state) => state.phase === "listening");
      const staleHost = hosts.host(SERVER_ID);
      hosts.invalidate(SERVER_ID);
      await call.until("the drop ends the call", (state) => state.phase === "ended");
      assert.ok(staleHost, "the registry has a host before the drop");
      const stale = await staleHost.start("agent-1", "offer-sdp").then(
        () => "started",
        (error: unknown) => (error instanceof Error ? error.message : "failed"),
      );
      const before = starts.length;
      currentPeer = createPeer();
      const fresh = openCall("agent-1");
      await fresh.until("a new host starts a call", (state) => state.phase === "listening");
      fresh.session.dispose();
      return {
        endedByDrop: call.latest()?.endReason === "failed",
        mediaReleased: call.media.closed,
        staleHostRefused: stale === sourceText("error.voice.live.disconnected"),
        staleHostSentNothing: before === starts.length - 1,
        newHostStarts: fresh.media.answers.join() === "answer-ok",
      };
    },
  ],
];

mkdirSync(OUT, { recursive: true });
const results: CaseResult[] = [];
for (const [name, run] of cases) {
  logger.info(`Case: ${name}.`);
  reset();
  try {
    const checks = await run();
    results.push({ name, passed: Object.values(checks).every(Boolean), checks });
  } catch (error) {
    results.push({ name, passed: false, checks: {}, error: error instanceof Error ? error.message : String(error) });
  }
  await settle();
}
hosts.dispose();
server.close();
const passed = results.every((result) => result.passed);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed, results }, null, 2)}\n`);
logger.info(`Checked ${results.length} cases. Wrote ${join(OUT, "report.json")}.`);
if (!passed) {
  for (const result of results.filter((candidate) => !candidate.passed)) {
    logger.error(`${result.name}: ${result.error ?? JSON.stringify(result.checks)}`);
  }
  process.exit(1);
}
process.exit(0);
