import { sourceText } from "@openbot/i18n/source";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BackHandler } from "react-native";
import { cancelAnimation, Easing, ReduceMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { mobileAnalytics } from "@/features/analytics/mobile-analytics";
import type { LiveConversation } from "@/features/chat/components/use-live-conversation";
import type { LiveConversationPhase } from "@/features/chat/model/live-conversation";
import { useMobileWorkspaceActions, useMobileWorkspaceSelector } from "@/features/workspace/context/workspace-store";
import { haptics } from "@/shared/lib/haptics";
import { currentText } from "@/shared/lib/text";
import { codexLiveNativeAvailable, createCodexLiveNative } from "../model/codex-live-native";
import { type CodexLivePhase, type CodexLiveSession, createCodexLiveSession } from "../model/codex-live-session";
import { useVoiceSettings } from "../model/voice-settings";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const OPEN_MS = 460;
const CLOSE_MS = 400;
const SPEAKING_PULSE_MS = 420;

const CALL_PHASES: Record<Exclude<CodexLivePhase, "ended">, LiveConversationPhase> = {
  idle: "starting",
  starting: "starting",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

interface CodexLiveVoiceInput {
  /** The chat is in front and the user can write here. */
  enabled: boolean;
  /** The agent's server is connected. */
  online: boolean;
  focused: boolean;
  foreground: boolean;
  serverId: string;
  /** Null in a channel, where this call is not offered. */
  agentId: string | null;
}

type CodexLiveVoiceState = Pick<
  LiveConversation,
  "open" | "phase" | "muted" | "caption" | "error" | "exit" | "speakerId"
>;

const CLOSED: CodexLiveVoiceState = {
  open: false,
  phase: "starting",
  muted: false,
  caption: "",
  error: null,
  exit: null,
  speakerId: null,
};

/**
 * A live voice call with one agent, as on desktop: the phone's audio goes to Codex live voice
 * directly, and the host keeps the agent and the transcript. The call ends when the user leaves the
 * chat or the app, or when the connection drops. After a failure, unmuting starts a new call.
 */
export function useCodexLiveVoice({
  enabled,
  online,
  focused,
  foreground,
  serverId,
  agentId,
}: CodexLiveVoiceInput): LiveConversation {
  const actions = useMobileWorkspaceActions();
  const canUseLiveVoice = useMobileWorkspaceSelector((current) => current.canUseLiveVoice(serverId));
  const optedIn = useVoiceSettings((settings) => settings.ready && settings.codexLiveEnabled);
  const available = Boolean(enabled && agentId && canUseLiveVoice && optedIn && codexLiveNativeAvailable());

  const [state, setState] = useState(CLOSED);
  const [askingPermission, setAskingPermission] = useState(false);
  // A render can follow more than one action. Resource ownership must change at once.
  const openRef = useRef(false);
  const sessionRef = useRef<CodexLiveSession | null>(null);
  const leavingRef = useRef(false);
  const failedRef = useRef(false);
  const startedAtRef = useRef(0);
  const presence = useSharedValue(0);
  const speechLevel = useSharedValue(0);

  const stopPulse = useCallback(() => {
    cancelAnimation(speechLevel);
    speechLevel.set(0);
  }, [speechLevel]);

  const close = useCallback(() => {
    openRef.current = false;
    leavingRef.current = false;
    failedRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.dispose();
    setAskingPermission(false);
    setState(CLOSED);
  }, []);

  const leave = useCallback(() => {
    if (!openRef.current || leavingRef.current) return;
    leavingRef.current = true;
    failedRef.current = false;
    setState((prev) => ({ ...prev, exit: "cancel" }));
    sessionRef.current?.end();
    stopPulse();
    void haptics.selection();
    mobileAnalytics.track("voice_conversation_action", {
      action: "end",
      server_kind: "remote",
      result: "succeeded",
      duration_ms: performance.now() - startedAtRef.current,
    });
    presence.set(
      withTiming(0, { duration: CLOSE_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.System }, (finished) => {
        if (finished) scheduleOnRN(close);
      }),
    );
  }, [presence, stopPulse, close]);

  /** The call stays open and muted, with the reason, until the user unmutes to try again. */
  const fail = useCallback(
    (error: Error | null) => {
      const { t, errorMessage } = currentText();
      failedRef.current = true;
      setAskingPermission(false);
      stopPulse();
      setState((prev) => ({
        ...prev,
        phase: "listening",
        muted: true,
        caption: "",
        error: errorMessage(error, t("mobile.chat.liveVoice.offline")),
      }));
    },
    [stopPulse],
  );

  const connect = useCallback(() => {
    if (!agentId || leavingRef.current) return;
    const host = actions.liveVoiceHost(serverId);
    if (!host) {
      fail(new Error(sourceText("error.voice.live.disconnected")));
      return;
    }
    const previous = sessionRef.current;
    sessionRef.current = null;
    previous?.dispose();
    setAskingPermission(false);
    failedRef.current = false;
    setState((prev) => ({ ...prev, phase: "starting", muted: false, caption: "", error: null }));

    const session: CodexLiveSession = createCodexLiveSession(host, (events) =>
      createCodexLiveNative({
        ...events,
        onPermissionChange: (asking) => {
          if (sessionRef.current === session && !leavingRef.current) setAskingPermission(asking);
        },
      }),
    );
    sessionRef.current = session;
    let previousPhase: LiveConversationPhase | null = null;
    session.subscribe((next) => {
      if (sessionRef.current !== session || leavingRef.current) return;
      if (next.phase === "ended") {
        if (next.endReason === "failed" || (next.endReason === "host-ended" && next.error)) fail(next.error);
        else leave();
        return;
      }
      const phase = CALL_PHASES[next.phase];
      if (phase !== previousPhase && phase === "speaking") {
        speechLevel.set(
          withRepeat(
            withTiming(0.55, { duration: SPEAKING_PULSE_MS, easing: Easing.inOut(Easing.ease) }),
            -1,
            true,
            undefined,
            ReduceMotion.System,
          ),
        );
      } else if (phase !== previousPhase) {
        stopPulse();
      }
      previousPhase = phase;
      setState((prev) => ({ ...prev, phase, muted: next.muted, caption: next.caption, error: null }));
    });
    void session.start(agentId, useVoiceSettings.getState().codexLiveVoice ?? undefined);
  }, [agentId, serverId, actions, speechLevel, stopPulse, fail, leave]);

  const start = useCallback(() => {
    if (!available || !online || !focused || !foreground || openRef.current || leavingRef.current) return;
    openRef.current = true;
    startedAtRef.current = performance.now();
    void haptics.impact("light");
    mobileAnalytics.track("voice_conversation_action", { action: "start", server_kind: "remote", result: "succeeded" });
    presence.set(withTiming(1, { duration: OPEN_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.System }));
    setState({ ...CLOSED, open: true });
    connect();
  }, [available, online, focused, foreground, presence, connect]);

  const toggleMute = useCallback(() => {
    if (!openRef.current || leavingRef.current) return;
    void haptics.selection();
    if (failedRef.current) {
      connect();
      return;
    }
    sessionRef.current?.toggleMute();
  }, [connect]);

  const interrupt = useCallback(() => {
    if (!openRef.current || leavingRef.current) return;
    void haptics.impact("light");
    sessionRef.current?.interrupt();
  }, []);

  // Android can report background during its permission dialog. Other departures still end the call.
  useEffect(() => {
    if (state.open && (!focused || (!foreground && !askingPermission) || !online)) leave();
  }, [state.open, focused, foreground, online, askingPermission, leave]);

  const keepAwakeTag = useId();
  useEffect(() => {
    if (!state.open) return;
    activateKeepAwakeAsync(keepAwakeTag).catch(() => {});
    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => {});
    };
  }, [state.open, keepAwakeTag]);

  // Back ends the call before it leaves the chat.
  useEffect(() => {
    if (!state.open || !focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      leave();
      return true;
    });
    return () => subscription.remove();
  }, [state.open, focused, leave]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      openRef.current = false;
      session?.dispose();
      cancelAnimation(presence);
      stopPulse();
    },
    [presence, stopPulse],
  );

  return {
    ...state,
    available,
    micOpen: state.phase === "listening" && !state.muted,
    level: speechLevel,
    presence,
    start,
    toggleMute,
    interrupt,
    end: leave,
  };
}
