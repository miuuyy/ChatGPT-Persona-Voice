import type { IconName } from "../icons";
import { formatMessage } from "../i18n";
import type { Messages, UiLocale } from "../i18n";
import type { LauncherSnapshot, Settings, TabId } from "../types";

export type SettingsSectionId =
  "audio" | "voice" | "history" | "application" | "diagnostics";

export function primaryTabs(messages: Messages): Array<{
  id: Exclude<TabId, "settings">;
  label: string;
  icon: IconName;
}> {
  return [
    { id: "home", label: messages.sidebar.voice, icon: "waveform" },
    { id: "history", label: messages.sidebar.history, icon: "history" },
  ];
}

export function settingsSections(messages: Messages): Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: IconName;
  keywords: string;
}> {
  return [
    { id: "audio", icon: "headphones", ...messages.settings.sections.audio },
    { id: "voice", icon: "sparkles", ...messages.settings.sections.voice },
    { id: "history", icon: "lock", ...messages.settings.sections.history },
    { id: "application", icon: "app", ...messages.settings.sections.application },
    { id: "diagnostics", icon: "info", ...messages.settings.sections.diagnostics },
  ];
}

export function errorMessage(error: unknown) {
  if (error instanceof Error)
    return error.message.replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
  return String(error);
}

export function platformName(value: string) {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number, locale: UiLocale) {
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) return `${number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${number(bytes / 1024 / 1024)} MB`;
  return `${number(bytes / 1024 / 1024 / 1024)} GB`;
}

export function retentionLabel(
  hours: Settings["retentionHours"],
  messages: Messages,
  locale: UiLocale,
) {
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  if (hours === null) return messages.history.retentionNever;
  if (hours === 1) return messages.history.retentionHourOne;
  if (hours < 24)
    return formatMessage(messages.history.retentionHours, { count: count(hours) });
  const days = hours / 24;
  if (days === 1) return messages.history.retentionDayOne;
  return formatMessage(messages.history.retentionDays, { count: count(days) });
}

export function statusLabel(snapshot: LauncherSnapshot, messages: Messages) {
  const { runtime } = snapshot;
  if (runtime.state === "running") return messages.runtime.voiceActive;
  if (runtime.state === "armed") return messages.runtime.waiting;
  if (runtime.state === "engaging") return messages.runtime.connecting;
  if (runtime.state === "starting") return messages.runtime.preparing;
  if (runtime.state === "stopping") return messages.runtime.restoring;
  if (runtime.state === "faulted")
    return runtime.suppressionUncertain
      ? messages.runtime.restorationUnproven
      : runtime.suppressionHeld
        ? messages.runtime.originalHeld
        : messages.runtime.routeUnavailable;
  return runtime.ready ? messages.common.ready : messages.common.setupNeeded;
}

export function sourceLabel(settings: Settings, messages: Messages) {
  return settings.sourceMode === "codex-app-server"
    ? messages.runtime.codexSession
    : settings.sourceName || targetAppLabel(settings.targetApp);
}

export function targetAppLabel(targetApp: Settings["targetApp"]) {
  return targetApp === "grok-bot" ? "Grok Bot" : "ChatGPT";
}

export function runtimeIsActive(snapshot: LauncherSnapshot) {
  return ["armed", "engaging", "running", "faulted"].includes(
    snapshot.runtime.state,
  );
}

export function runtimeActionLabel(
  snapshot: LauncherSnapshot,
  messages: Messages,
) {
  if (snapshot.runtime.state === "starting") return messages.runtime.cancelStart;
  if (snapshot.runtime.state === "stopping") return messages.runtime.restoringAction;
  if (snapshot.runtime.state === "faulted") return messages.runtime.restoreAudio;
  return runtimeIsActive(snapshot)
    ? messages.runtime.stopVoice
    : messages.runtime.startVoice;
}

export function dayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(value: string, locale: UiLocale, messages: Messages) {
  const date = new Date(value);
  const now = new Date();
  const today = dayKey(now.toISOString());
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  if (dayKey(value) === today) return messages.history.today;
  if (dayKey(value) === dayKey(yesterdayDate.toISOString()))
    return messages.history.yesterday;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}
