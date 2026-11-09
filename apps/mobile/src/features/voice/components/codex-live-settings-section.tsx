import { CODEX_LIVE_VOICES, type CodexLiveVoice } from "@openbot/contracts/ipc";
import { Typography } from "heroui-native";
import { useUniwind } from "uniwind";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { SettingsPicker, SettingsSwitch } from "@/features/settings/components/settings-controls";
import { useText } from "@/shared/lib/text";
import { codexLiveNativeAvailable } from "../model/codex-live-native";
import { saveVoiceSettings, useVoiceSettings } from "../model/voice-settings";

type VoiceChoice = CodexLiveVoice | "automatic";

/** The voices' own names, which stay the same in each language, as on desktop. */
const voiceName = (voice: CodexLiveVoice) => voice.charAt(0).toUpperCase() + voice.slice(1);

/**
 * The opt-in to Codex live voice and its voice, as on desktop. The other voice settings on this
 * page stay for the voice conversations that the opt-in does not cover.
 */
export function CodexLiveSettingsSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useText();
  const { theme } = useUniwind();
  const ready = useVoiceSettings((state) => state.ready);
  const enabled = useVoiceSettings((state) => state.codexLiveEnabled);
  const voice = useVoiceSettings((state) => state.codexLiveVoice);
  const available = codexLiveNativeAvailable();
  const save = (change: { codexLiveEnabled: boolean } | { codexLiveVoice: CodexLiveVoice | null }) => {
    void saveVoiceSettings(change).catch(() => onError(t("mobile.settings.saveFailed")));
  };
  return (
    <SettingsSection
      title={t("mobile.settings.voice.codex.title")}
      footer={available ? undefined : t("mobile.settings.voice.codex.unavailable")}
    >
      <SettingsRow supportingText={t("mobile.settings.voice.codex.footer")}>
        <SettingsSwitch
          value={enabled}
          disabled={!ready || !available}
          label={t("mobile.settings.voice.codex.enable")}
          dark={theme === "dark"}
          onValueChange={(codexLiveEnabled) => save({ codexLiveEnabled })}
        />
      </SettingsRow>
      {enabled && available ? (
        <SettingsRow
          trailing={
            <SettingsPicker<VoiceChoice>
              value={voice ?? "automatic"}
              options={[
                { value: "automatic", label: t("mobile.settings.voice.codex.automatic") },
                ...CODEX_LIVE_VOICES.map((value) => ({ value, label: voiceName(value) })),
              ]}
              enabled={ready}
              dark={theme === "dark"}
              label={t("mobile.settings.voice.voice")}
              onChange={(value) => save({ codexLiveVoice: value === "automatic" ? null : value })}
            />
          }
        >
          <Typography.Paragraph>{t("mobile.settings.voice.voice")}</Typography.Paragraph>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
