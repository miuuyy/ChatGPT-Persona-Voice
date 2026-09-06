import { Icon } from "../icons";
import type { IconName } from "../icons";
import { formatMessage, useI18n } from "../i18n";
import type { LauncherSnapshot, ReadinessCheck } from "../types";
import {
  runtimeActionLabel,
  runtimeIsActive,
  sourceLabel,
  statusLabel,
  type SettingsSectionId,
} from "../lib/presentation";
import { StatusDot } from "../components/AppShell";

const SESSION_ART_BY_VOICE_ID: Readonly<Record<string, string>> = {
  "voicevox-shikoku-metan-normal": new URL(
    "../assets/voices/shikoku-metan-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-zundamon-normal": new URL(
    "../assets/voices/zundamon-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-kasukabe-tsumugi-normal": new URL(
    "../assets/voices/kasukabe-tsumugi-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-meimei-himari-normal": new URL(
    "../assets/voices/meimei-himari-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-kyushu-sora-normal": new URL(
    "../assets/voices/kyushu-sora-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-whitecul-normal": new URL(
    "../assets/voices/whitecul-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-ouka-miko-normal": new URL(
    "../assets/voices/ouka-miko-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-sayo-normal": new URL(
    "../assets/voices/sayo-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-haruka-nana-normal": new URL(
    "../assets/voices/haruka-nana-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-nekotsuka-aru-normal": new URL(
    "../assets/voices/nekotsuka-aru-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-manbetsu-hanamaru-normal": new URL(
    "../assets/voices/manbetsu-hanamaru-session-scene.png",
    import.meta.url,
  ).href,
  "voicevox-kotoyomi-nia-normal": new URL(
    "../assets/voices/kotoyomi-nia-session-scene.png",
    import.meta.url,
  ).href,
};

function RouteRow({
  icon,
  label,
  value,
  action,
  onClick,
}: {
  icon: IconName;
  label: string;
  value: string;
  action?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="route-row-icon">
        <Icon name={icon} />
      </span>
      <span className="route-row-copy">
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      {action ? (
        <span className="route-row-action">
          {action}
          <Icon name="chevron" />
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button className="route-row" onClick={onClick} type="button">
      {content}
    </button>
  ) : (
    <div className="route-row">{content}</div>
  );
}

function ReadinessRow({ check }: { check: ReadinessCheck }) {
  const { messages } = useI18n();
  const labels: Record<ReadinessCheck["id"], string> = {
    source: messages.home.checkSource,
    suppression: messages.home.checkSuppression,
    engine: messages.home.checkEngine,
    output: messages.home.checkOutput,
  };
  return (
    <div className="check-row">
      <span className={`check-icon${check.ready ? " is-ready" : ""}`}>
        <Icon name={check.ready ? "check" : "alert"} />
      </span>
      <span className="check-copy">
        <strong>{labels[check.id]}</strong>
        <small>{check.detail}</small>
      </span>
      <span className={`check-state${check.ready ? " is-ready" : ""}`}>
        {check.ready ? messages.common.ready : messages.common.blocked}
      </span>
    </div>
  );
}

export function HomePage({
  snapshot,
  busy,
  onStart,
  onStop,
  onOpenSettings,
  onRefresh,
}: {
  snapshot: LauncherSnapshot;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpenSettings: (section: SettingsSectionId) => void;
  onRefresh: () => void;
}) {
  const { locale, messages } = useI18n();
  const { runtime, settings } = snapshot;
  const active = runtimeIsActive(snapshot);
  const stopping = runtime.state === "stopping";
  const actionableAsStop = active || runtime.state === "starting";
  const selectedVoice = snapshot.voices.find(
    (voice) => voice.id === settings.selectedVoiceId,
  );
  const sessionArt = selectedVoice
    ? SESSION_ART_BY_VOICE_ID[selectedVoice.id]
    : undefined;
  const sessionArtActive = !["stopped", "faulted"].includes(runtime.state);
  const blockers = runtime.checks.filter((check) => !check.ready);
  const actionDisabled =
    stopping ||
    (busy && runtime.state !== "starting") ||
    (!runtime.ready && !actionableAsStop);
  const detail =
    runtime.state === "armed"
      ? messages.home.armedDetail
      : runtime.state === "running"
        ? formatMessage(messages.home.runningDetail, {
            voice: settings.selectedVoiceName || messages.home.selectedVoice,
          })
        : runtime.state === "starting"
          ? messages.home.startingDetail
          : runtime.state === "stopping"
            ? messages.home.stoppingDetail
            : runtime.state === "faulted"
              ? runtime.error ||
                messages.home.faultedDetail
              : runtime.ready
                ? messages.home.readyDetail
                : formatMessage(
                    blockers.length === 1
                      ? messages.home.blockedDetailOne
                      : messages.home.blockedDetailOther,
                    { count: new Intl.NumberFormat(locale).format(blockers.length) },
                  );

  return (
    <section className="content-surface">
      <div className="page-scroll home-page">
        <div className="page-intro">
          <h1>{messages.home.title}</h1>
          <p>{messages.home.intro}</p>
        </div>
        <section
          aria-label={messages.home.relayControl}
          className={`session-card is-${runtime.state}${sessionArt ? ` has-character-art ${sessionArtActive ? "is-art-active" : "is-art-inactive"}` : ""}`}
        >
          {sessionArt ? (
            <img
              alt=""
              aria-hidden="true"
              className="session-character-art"
              src={sessionArt}
            />
          ) : null}
          <div className="session-copy">
            <div className="session-status">
              <StatusDot state={runtime.state} />
              <span>{statusLabel(snapshot, messages)}</span>
            </div>
            <h2>{selectedVoice?.name || messages.home.selectVoice}</h2>
            <p>{detail}</p>
            <div className="session-actions">
              <button
                className={`button-primary${actionableAsStop ? " is-stop" : ""}`}
                disabled={actionDisabled}
                onClick={actionableAsStop ? onStop : onStart}
                type="button"
              >
                <Icon
                  name={runtime.state === "faulted" ? "refresh" : "power"}
                />
                {runtimeActionLabel(snapshot, messages)}
              </button>
              {!runtime.ready && !active ? (
                <button
                  className="button-secondary"
                  onClick={() => onOpenSettings(blockers.some((check) => check.id === "engine") ? "voice" : "diagnostics")}
                  type="button"
                >
                  {messages.home.reviewSetup}
                </button>
              ) : null}
            </div>
            <div className="session-facts">
              <span>
                <Icon name="lock" /> {messages.home.localProcessing}
              </span>
              <span>
                {runtime.queuedAudioMs > 0
                  ? formatMessage(messages.home.queued, {
                      milliseconds: new Intl.NumberFormat(locale).format(runtime.queuedAudioMs),
                    })
                  : snapshot.models.find((model) => model.id === settings.selectedModelId)!.name}
              </span>
            </div>
          </div>
        </section>
        {runtime.error ? (
          <div className="inline-notice is-error" role="alert">
            <Icon name="alert" />
            <span>{runtime.error}</span>
          </div>
        ) : null}
        <div className="home-columns">
          <section className="panel-section">
            <div className="panel-heading">
              <div>
                <h2>{messages.home.currentRoute}</h2>
                <p>{messages.home.currentRouteBody}</p>
              </div>
            </div>
            <div className="row-group">
              <RouteRow
                action={messages.home.change}
                icon="app"
                label={messages.home.source}
                onClick={() => onOpenSettings("audio")}
                value={sourceLabel(settings, messages)}
              />
              <RouteRow
                action={messages.home.change}
                icon="sparkles"
                label={messages.home.voice}
                onClick={() => onOpenSettings("voice")}
                value={settings.selectedVoiceName || messages.home.notSelected}
              />
              <RouteRow
                icon="headphones"
                label={messages.home.output}
                value={messages.home.systemDefault}
              />
            </div>
          </section>
          <section className="panel-section">
            <div className="panel-heading with-action">
              <div>
                <h2>{messages.home.systemCheck}</h2>
                <p>
                  {runtime.ready
                    ? messages.home.systemReady
                    : messages.home.systemBlocked}
                </p>
              </div>
              <button
                aria-label={messages.home.refreshCheck}
                className="icon-button"
                disabled={busy || runtime.state !== "stopped"}
                onClick={onRefresh}
                title={messages.home.refreshCheck}
                type="button"
              >
                <Icon name="refresh" />
              </button>
            </div>
            <div className="check-list">
              {runtime.checks.map((check) => (
                <ReadinessRow check={check} key={check.id} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
