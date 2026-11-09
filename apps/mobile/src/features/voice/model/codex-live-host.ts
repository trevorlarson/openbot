import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  decodeLiveVoiceSessionResponse,
  LIVE_VOICE_ROUTES,
  type LiveVoiceEvent,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { isFixedSourceText, sourceText } from "@openbot/i18n/source";
import type { CodexLiveHost } from "./codex-live-session";

/** The authenticated request boundary; independent of the component that implements it. */
interface LiveVoicePeer {
  fetchRaw(method: string, path: string, body?: TeamProtocolV2Json): Promise<{ status: number; body: unknown }>;
  disconnect(): Promise<void>;
}
type RawResponse = Awaited<ReturnType<LiveVoicePeer["fetchRaw"]>>;
type Subscribe = CodexLiveHost["subscribe"];

const disconnected = () => new Error(sourceText("error.voice.live.disconnected"));

/** The host's own refusals are fixed source messages. Any other response text stays private. */
function refusal(result: RawResponse): Error {
  const message = isDynamicRecord(result.body) && isString(result.body.error) ? result.body.error : "";
  return new Error(isFixedSourceText(message) ? message : sourceText("error.voice.live.disconnected"));
}

const succeeded = (result: RawResponse) => result.status >= 200 && result.status < 300;

/**
 * Starts and stops calls on the authenticated Team connection. It logs no offer, answer or
 * transcript.
 */
export function createCodexLiveHost(peer: LiveVoicePeer, subscribe: Subscribe): CodexLiveHost {
  let closed = false;
  const disconnect = () => {
    if (closed) return;
    closed = true;
    void peer.disconnect().catch(() => undefined);
  };
  return {
    start: async (agentId, sdp, voice) => {
      // A start is not idempotent. A lost or malformed answer leaves no session ID to stop, so the
      // connection that sent it closes and the host releases that uncertain call.
      let result: RawResponse;
      try {
        result = await peer.fetchRaw("POST", LIVE_VOICE_ROUTES.start, { agentId, sdp, ...(voice ? { voice } : {}) });
      } catch {
        disconnect();
        throw disconnected();
      }
      if (!succeeded(result)) throw refusal(result);
      try {
        return decodeLiveVoiceSessionResponse(result.body);
      } catch {
        disconnect();
        throw disconnected();
      }
    },
    stop: async (sessionId) => {
      const result = await peer.fetchRaw("POST", LIVE_VOICE_ROUTES.stop, { sessionId }).catch(() => null);
      if (!result || !succeeded(result)) throw disconnected();
    },
    disconnect,
    subscribe,
  };
}

interface Listener {
  event: (event: LiveVoiceEvent) => void;
  unavailable: () => void;
}

/**
 * Hosts for voice calls, each bound to the connection that is current when the call starts. When
 * that connection drops or changes, including a reconnect of the same peer, its calls end.
 */
export function createCodexLiveHosts(currentPeer: (serverId: string) => LiveVoicePeer | null) {
  const generations = new Map<string, number>();
  const listeners = new Map<string, Set<Listener>>();
  const generation = (serverId: string) => generations.get(serverId) ?? 0;

  const invalidate = (serverId: string) => {
    generations.set(serverId, generation(serverId) + 1);
    const subscribed = listeners.get(serverId);
    listeners.delete(serverId);
    for (const listener of subscribed ?? []) listener.unavailable();
  };

  return {
    host(serverId: string): CodexLiveHost | null {
      const peer = currentPeer(serverId);
      if (!peer) return null;
      const bound = generation(serverId);
      const current = () => currentPeer(serverId) === peer && generation(serverId) === bound;
      return createCodexLiveHost(
        {
          fetchRaw: (...args) => (current() ? peer.fetchRaw(...args) : Promise.reject(disconnected())),
          disconnect: () => (current() ? peer.disconnect() : Promise.resolve()),
        },
        (event, unavailable) => {
          if (!current()) {
            unavailable();
            return () => {};
          }
          const listener = { event, unavailable };
          const subscribed = listeners.get(serverId) ?? new Set<Listener>();
          subscribed.add(listener);
          listeners.set(serverId, subscribed);
          return () => {
            subscribed.delete(listener);
            if (subscribed.size === 0 && listeners.get(serverId) === subscribed) listeners.delete(serverId);
          };
        },
      );
    },
    event(serverId: string, event: LiveVoiceEvent) {
      for (const listener of listeners.get(serverId) ?? []) listener.event(event);
    },
    invalidate,
    dispose() {
      for (const serverId of [...listeners.keys()]) invalidate(serverId);
    },
  };
}
