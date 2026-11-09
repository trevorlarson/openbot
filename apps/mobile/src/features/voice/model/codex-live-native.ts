import { sourceText } from "@openbot/i18n/source";
import { NativeModules, PermissionsAndroid, Platform } from "react-native";
import type { MediaStream, MediaStreamTrack, RTCPeerConnection } from "react-native-webrtc";
import type { CodexLiveMedia, CodexLiveMediaEvents } from "./codex-live-session";
import { speechNative } from "./speech-native";

/**
 * Whether this app binary contains WebRTC. An update of the JavaScript can reach a binary from
 * before it, and importing `react-native-webrtc` there throws, so the library loads only when a call
 * starts.
 */
export function codexLiveNativeAvailable(): boolean {
  return NativeModules.WebRTCModule != null;
}

const callEnded = () => new Error(sourceText("error.voice.live.disconnected"));

/** The phone's side of one call: its microphone, the model's audio and the model's event channel. */
export function createCodexLiveNative({
  onMessage,
  onFailure,
  onPermissionChange,
}: CodexLiveMediaEvents): CodexLiveMedia {
  let closed = false;
  let muted = false;
  let replyAudioOn = true;
  let microphone: MediaStream | null = null;
  let connection: RTCPeerConnection | null = null;
  let channel: ReturnType<RTCPeerConnection["createDataChannel"]> | null = null;
  const replyTracks = new Set<MediaStreamTrack>();

  async function requestMicrophone(): Promise<void> {
    if (Platform.OS !== "android") return;
    onPermissionChange?.(true);
    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error(sourceText("error.voice.live.microphoneDenied"));
      }
    } finally {
      onPermissionChange?.(false);
    }
  }

  return {
    offer: async () => {
      if (closed) throw callEnded();
      await requestMicrophone();
      if (closed) throw callEnded();
      const webrtc = await import("react-native-webrtc");
      if (closed) throw callEnded();
      // WebRTC owns the audio session for the call, so the phone's reader and recognizer stop first.
      speechNative?.stop();
      speechNative?.cancelCapture?.();
      const stream = await webrtc.mediaDevices.getUserMedia({ audio: true, video: false });
      if (closed) {
        for (const track of stream.getTracks()) track.stop();
        stream.release();
        throw callEnded();
      }
      microphone = stream;
      const peer = new webrtc.RTCPeerConnection();
      connection = peer;
      for (const track of stream.getAudioTracks()) {
        track.enabled = !muted;
        track.addEventListener("ended", onFailure);
        peer.addTrack(track, stream);
      }
      peer.addEventListener("track", (event) => {
        const { track } = event;
        if (closed || track?.kind !== "audio") return;
        track.enabled = replyAudioOn;
        replyTracks.add(track);
      });
      peer.addEventListener("connectionstatechange", () => {
        if (!closed && (peer.connectionState === "failed" || peer.connectionState === "disconnected")) onFailure();
      });
      channel = peer.createDataChannel("oai-events");
      channel.addEventListener("message", (event) => {
        if (!closed && typeof event.data === "string") onMessage(event.data);
      });
      const offer = await peer.createOffer();
      if (closed) throw callEnded();
      await peer.setLocalDescription(offer);
      if (closed || !offer.sdp) throw callEnded();
      return offer.sdp;
    },
    answer: async (sdp) => {
      if (closed || !connection) throw callEnded();
      await connection.setRemoteDescription({ type: "answer", sdp });
    },
    mute: (value) => {
      muted = value;
      for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !value;
    },
    setReplyAudio: (on) => {
      replyAudioOn = on;
      for (const track of replyTracks) track.enabled = on;
    },
    close: () => {
      if (closed) return;
      closed = true;
      channel?.close();
      connection?.close();
      for (const track of microphone?.getTracks() ?? []) track.stop();
      microphone?.release();
      replyTracks.clear();
      microphone = null;
      connection = null;
      channel = null;
    },
  };
}
