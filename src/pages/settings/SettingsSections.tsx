import { useEffect, useState } from "react";
import { Icon } from "../../icons";
import {
  formatMessage,
  isUiLocale,
  localeOptions,
  useI18n,
} from "../../i18n";
import type {
  AudioSource,
  LauncherSnapshot,
  PlatformAudioSetupState,
  Settings,
  UserSettingKey,
  VoicePreset,
} from "../../types";
import { Switch } from "../../components/AppShell";
import {
  errorMessage,
  formatBytes,
  platformName,
  type SettingsSectionId,
} from "../../lib/presentation";
import {
  CapabilityRow,
  SettingRow,
  SourceChoice,
  VoiceChoice,
} from "./SettingsPrimitives";

type PlatformAudioAction = "refresh" | "install" | "activate" | "remove" | "download";

export type SettingsSectionProps = {
  snapshot: LauncherSnapshot;
  section: SettingsSectionId;
  busy: boolean;
  sources: AudioSource[];
  sourceLoading: boolean;
  playingKey: string | null;
  onSetting: <Key extends UserSettingKey>(key: Key, value: Settings[Key]) => void;
  onInstallEngine: () => void;
  onCancelEngineInstall: () => void;
  onRemoveEngine: () => void;
  onAutostart: (value: boolean) => void;
  onMode: (mode: Settings["sourceMode"]) => void;
  onDiscoverSources: () => void;
  onSelectSource: (source: AudioSource | null) => void;
  onSelectVoice: (id: string) => void;
  onPreviewVoice: (voice: VoicePreset) => void;
  onVoiceTerms: (voice: VoicePreset) => void;
  onRequestClear: () => void;
  onOpenData: () => void;
  onOpenRepository: () => void;
};

export function SettingsSections({
  snapshot,
  section,
  busy,
  sources,
  sourceLoading,
  playingKey,
  onSetting,
  onInstallEngine,
  onCancelEngineInstall,
  onRemoveEngine,
  onAutostart,
  onMode,
  onDiscoverSources,
  onSelectSource,
  onSelectVoice,
  onPreviewVoice,
  onVoiceTerms,
  onRequestClear,
  onOpenData,
  onOpenRepository,
}: SettingsSectionProps) {
  const { locale, messages } = useI18n();
  const [platformAudioSetup, setPlatformAudioSetup] =
    useState<PlatformAudioSetupState>(snapshot.platformAudioSetup);
  const [platformAudioAction, setPlatformAudioAction] =
    useState<PlatformAudioAction | null>(null);
  const [platformAudioError, setPlatformAudioError] = useState<string | null>(null);
  const { settings, capabilities } = snapshot;

  useEffect(() => {
    setPlatformAudioSetup(snapshot.platformAudioSetup);
  }, [snapshot.platformAudioSetup]);

  async function runPlatformAudioAction(action: PlatformAudioAction) {
    const bridge = window.codexPersonaVoice;
    if (!bridge) {
      setPlatformAudioError(messages.platformAudio.bridgeUnavailable);
      return;
    }
    setPlatformAudioAction(action);
    setPlatformAudioError(null);
    try {
      if (action === "download") {
        await bridge.openWindowsAudioSetupDownload();
        return;
      }
      const result = action === "install"
        ? await bridge.installPlatformAudioSetup()
        : action === "activate"
          ? await bridge.activatePlatformAudioSetup()
          : action === "remove"
            ? await bridge.removePlatformAudioSetup()
            : await bridge.refreshPlatformAudioSetup();
      setPlatformAudioSetup(result);
    } catch (cause) {
      setPlatformAudioError(errorMessage(cause));
    } finally {
      setPlatformAudioAction(null);
    }
  }

  const platformAudioStatusLabel = {
    ready: messages.platformAudio.statusReady,
    "action-required": messages.platformAudio.statusActionRequired,
    installing: messages.platformAudio.statusInstalling,
    error: messages.platformAudio.statusError,
    unavailable: messages.platformAudio.statusUnavailable,
  }[platformAudioSetup.status];
  const platformAudioBusy =
    busy || platformAudioAction !== null || platformAudioSetup.status === "installing";
  const desktopReady =
    capabilities.desktopCapture.ready && capabilities.suppression.ready;
  const selectedVoice = snapshot.voices.find(
    (voice) => voice.id === settings.selectedVoiceId,
  );
  const selectedSourceMissing =
    settings.sourceId !== null &&
    !sources.some((source) => source.id === settings.sourceId);
  const engineCheck = snapshot.runtime.checks.find(
    (check) => check.id === "engine",
  );
  const engineInstallation = snapshot.engineInstallation;
  const totalHistoryBytes = snapshot.history.reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  const workerStateLabel = {
    stopped: messages.settings.diagnostics.workerStopped,
    loading: messages.settings.diagnostics.workerLoading,
    ready: messages.settings.diagnostics.workerReady,
  }[snapshot.engineDiagnostics.workerState];

  if (section === "audio")
    return (
      <>
        {!desktopReady ? (
          <div className="settings-callout is-warning">
            <Icon name="alert" />
            <div>
              <strong>{messages.settings.audio.unavailableTitle}</strong>
              <p>{capabilities.suppression.detail}</p>
            </div>
          </div>
        ) : null}
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.audio.sourceMethod}</h3>
            <p>{messages.settings.audio.sourceMethodBody}</p>
          </div>
          <div className="source-choices">
            <SourceChoice
              active={settings.sourceMode === "desktop-application"}
              badge={desktopReady ? undefined : messages.common.unavailable}
              description={messages.settings.audio.desktopBody}
              disabled={busy || !desktopReady}
              icon="app"
              onClick={() => onMode("desktop-application")}
              title={messages.settings.audio.desktopTitle}
            />
            <SourceChoice
              active={settings.sourceMode === "codex-app-server"}
              badge={
                capabilities.ownedSession.ready ? undefined : messages.common.notBundled
              }
              description={messages.settings.audio.codexBody}
              disabled={busy || !capabilities.ownedSession.ready}
              icon="server"
              onClick={() => onMode("codex-app-server")}
              title={messages.settings.audio.codexTitle}
            />
          </div>
        </div>
        {settings.sourceMode === "desktop-application" ? (
          <div className="settings-block">
            <div className="settings-block-heading">
              <h3>{messages.settings.audio.application}</h3>
              <p>{messages.settings.audio.applicationBody}</p>
            </div>
            <div className="settings-list">
              <SettingRow
                description={
                  settings.sourceId
                    ? messages.settings.audio.pinnedSource
                    : messages.settings.audio.automaticSource
                }
                title={settings.sourceName || messages.settings.audio.automaticApps}
              >
                <div className="source-select-control">
                  <select
                    aria-label={messages.settings.audio.sourceLabel}
                    disabled={busy || sourceLoading || !desktopReady}
                    onChange={(event) =>
                      onSelectSource(
                        sources.find(
                          (candidate) => candidate.id === event.target.value,
                        ) || null,
                      )
                    }
                    value={settings.sourceId || ""}
                  >
                    <option value="">{messages.common.automatic}</option>
                    {selectedSourceMissing ? (
                      <option value={settings.sourceId!}>
                        {settings.sourceName}
                      </option>
                    ) : null}
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                  <button
                    aria-label={messages.settings.audio.refreshApps}
                    className="icon-button bordered"
                    disabled={busy || sourceLoading || !desktopReady}
                    onClick={onDiscoverSources}
                    title={messages.settings.audio.refreshApps}
                    type="button"
                  >
                    <Icon name="refresh" />
                  </button>
                </div>
              </SettingRow>
            </div>
          </div>
        ) : null}
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.audio.routeGuarantee}</h3>
            <p>{messages.settings.audio.routeGuaranteeBody}</p>
          </div>
          <div className="settings-list compact-list">
            <CapabilityRow
              capability={capabilities.desktopCapture}
              icon="microphone"
              title={messages.settings.audio.processCapture}
            />
            <CapabilityRow
              capability={capabilities.suppression}
              icon="shield"
              title={messages.settings.audio.originalSuppression}
            />
            <CapabilityRow
              capability={capabilities.output}
              icon="headphones"
              title={messages.settings.audio.convertedOutput}
            />
          </div>
        </div>
      </>
    );
  if (section === "voice")
    return (
      <>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.voice.installedVoices}</h3>
            <p>{messages.settings.voice.installedVoicesBody}</p>
          </div>
          <div className="voice-list">
            {snapshot.voices.map((voice, index) => (
              <VoiceChoice
                disabled={busy}
                index={index}
                key={voice.id}
                onPreview={() => onPreviewVoice(voice)}
                onSelect={() => onSelectVoice(voice.id)}
                onTerms={() => onVoiceTerms(voice)}
                playing={playingKey === `voice:${voice.id}`}
                selected={settings.selectedVoiceId === voice.id}
                voice={voice}
              />
            ))}
          </div>
        </div>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.voice.engineProfile}</h3>
            <p>{messages.settings.voice.engineProfileBody}</p>
          </div>
          <div className="profile-card">
            <span className="profile-mark">
              <Icon name="sparkles" />
            </span>
            <div>
              <strong>Seed-VC tiny · realtime</strong>
              <p>{engineCheck?.detail || capabilities.engine.detail}</p>
              <small>
                {messages.settings.voice.profileFacts}
              </small>
            </div>
            <span
              className={`profile-state${engineCheck?.ready ? " is-ready" : ""}`}
            >
              {engineCheck?.ready ? messages.common.ready : messages.common.setupNeeded}
            </span>
          </div>
          <div className={`engine-package is-${engineInstallation.status}`}>
            <div className="engine-package-copy">
              <strong>{messages.settings.voice.enginePackage}</strong>
              <p>{engineInstallation.detail}</p>
              <small>
                {engineInstallation.status === "ready"
                  ? formatMessage(messages.settings.voice.installedLocally, {
                      size: formatBytes(engineInstallation.installedBytes, locale),
                    })
                  : formatMessage(messages.settings.voice.installSize, {
                      installed: formatBytes(engineInstallation.estimatedInstalledBytes, locale),
                      free: formatBytes(engineInstallation.minimumFreeBytes, locale),
                    })}
              </small>
            </div>
            {engineInstallation.status === "installing" ? (
              <>
                <div
                  aria-label={formatMessage(messages.settings.voice.installProgress, {
                    percent: Math.round(engineInstallation.progress * 100),
                  })}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(engineInstallation.progress * 100)}
                  className="engine-progress"
                  role="progressbar"
                >
                  <span style={{ width: `${engineInstallation.progress * 100}%` }} />
                </div>
                <button
                  className="button-secondary"
                  disabled={!engineInstallation.cancellable}
                  onClick={onCancelEngineInstall}
                  type="button"
                >
                  {messages.common.cancel}
                </button>
              </>
            ) : engineInstallation.status === "ready" ? (
              <button
                className="button-secondary danger-text"
                disabled={busy}
                onClick={onRemoveEngine}
                type="button"
              >
                {messages.settings.voice.remove}
              </button>
            ) : engineInstallation.status === "error" ? (
              <div className="engine-actions">
                <button
                  className="button-secondary"
                  disabled={busy}
                  onClick={onInstallEngine}
                  type="button"
                >
                  {engineInstallation.resumable
                    ? messages.settings.voice.resume
                    : messages.settings.voice.retry}
                </button>
                <button
                  className="button-secondary danger-text"
                  disabled={busy}
                  onClick={onRemoveEngine}
                  type="button"
                >
                  {messages.settings.voice.reset}
                </button>
              </div>
            ) : engineInstallation.status === "unavailable" ? null : (
              <button
                className="button-secondary"
                disabled={busy || engineInstallation.status === "removing"}
                onClick={onInstallEngine}
                type="button"
              >
                {engineInstallation.status === "removing"
                  ? messages.settings.voice.removing
                  : engineInstallation.resumable
                    ? messages.settings.voice.resume
                    : messages.settings.voice.installEngine}
              </button>
            )}
          </div>
          <div className="settings-footnote inline">
            <Icon name="lock" />
            <span>{messages.settings.voice.downloadNotice}</span>
          </div>
        </div>
        {selectedVoice ? (
          <div className="settings-footnote">
            <Icon name="shield" />
            <span>
              {formatMessage(messages.settings.voice.creditNotice, {
                credit: selectedVoice.requiredCredit,
              })}
            </span>
          </div>
        ) : null}
      </>
    );
  if (section === "history")
    return (
      <>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.history.localHistory}</h3>
            <p>{messages.settings.history.localHistoryBody}</p>
          </div>
          <div className="settings-list">
            <SettingRow
              description={messages.settings.history.saveAudioBody}
              title={messages.settings.history.saveAudio}
            >
              <Switch
                checked={settings.saveConvertedAudio}
                disabled={busy}
                label={messages.settings.history.saveAudio}
                onChange={(value) => onSetting("saveConvertedAudio", value)}
              />
            </SettingRow>
            <SettingRow
              description={messages.settings.history.deleteBody}
              title={messages.settings.history.deleteAutomatically}
            >
              <select
                aria-label={messages.settings.history.retentionLabel}
                disabled={busy || !settings.saveConvertedAudio}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "never") {
                    onSetting("retentionHours", null);
                    return;
                  }
                  if (!["1", "6", "24", "72", "168"].includes(value)) {
                    throw new Error("Invalid history retention option");
                  }
                  onSetting(
                    "retentionHours",
                    Number(value) as Exclude<Settings["retentionHours"], null>,
                  );
                }}
                value={settings.retentionHours ?? "never"}
              >
                <option value={1}>{messages.settings.history.after1Hour}</option>
                <option value={6}>{messages.settings.history.after6Hours}</option>
                <option value={24}>{messages.settings.history.after1Day}</option>
                <option value={72}>{messages.settings.history.after3Days}</option>
                <option value={168}>{messages.settings.history.after7Days}</option>
                <option value="never">{messages.common.never}</option>
              </select>
            </SettingRow>
          </div>
        </div>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.history.storage}</h3>
            <p>
              {formatMessage(
                snapshot.history.length === 1
                  ? messages.settings.history.storageOne
                  : messages.settings.history.storageOther,
                {
                  count: new Intl.NumberFormat(locale).format(snapshot.history.length),
                  size: formatBytes(totalHistoryBytes, locale),
                },
              )}
            </p>
          </div>
          <div className="settings-list">
            <SettingRow
              description={messages.settings.history.clearHistoryBody}
              title={messages.settings.history.clearHistory}
            >
              <button
                className="button-secondary danger-text"
                disabled={busy || snapshot.history.length === 0}
                onClick={onRequestClear}
                type="button"
              >
                {messages.settings.history.clear}
              </button>
            </SettingRow>
          </div>
        </div>
        <div className="settings-footnote">
          <Icon name="lock" />
          <span>{messages.settings.history.localNotice}</span>
        </div>
      </>
    );
  if (section === "application")
    return (
      <>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.application.language}</h3>
            <p>{messages.settings.application.languageBody}</p>
          </div>
          <div className="settings-list">
            <SettingRow
              description={messages.settings.application.languageBody}
              title={messages.settings.application.languageLabel}
            >
              <select
                aria-label={messages.settings.application.languageLabel}
                disabled={busy}
                onChange={(event) => {
                  if (!isUiLocale(event.target.value)) {
                    throw new Error("Invalid interface language option");
                  }
                  onSetting("uiLocale", event.target.value);
                }}
                value={settings.uiLocale || ""}
              >
                {localeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </SettingRow>
          </div>
        </div>
        <div className="settings-block">
          <div className="settings-block-heading">
            <h3>{messages.settings.application.launcher}</h3>
            <p>{messages.settings.application.launcherBody}</p>
          </div>
          <div className="settings-list">
            <SettingRow
              description={
                snapshot.autostart.supported
                  ? messages.settings.application.launchSupported
                  : messages.settings.application.launchUnsupported
              }
              title={messages.settings.application.launchAtLogin}
            >
              <Switch
                checked={settings.launchAtLogin}
                disabled={
                  busy ||
                  !snapshot.app.packaged ||
                  !snapshot.autostart.supported
                }
                label={messages.settings.application.launchAtLogin}
                onChange={onAutostart}
              />
            </SettingRow>
            <SettingRow
              description={messages.settings.application.keepRunningBody}
              title={messages.settings.application.keepRunning}
            >
              <Switch
                checked={settings.keepRunningOnClose}
                disabled={busy}
                label={messages.settings.application.keepRunning}
                onChange={(value) => onSetting("keepRunningOnClose", value)}
              />
            </SettingRow>
          </div>
        </div>
        {snapshot.app.platform === "linux" || snapshot.app.platform === "win32" ? (
          <div className="settings-block platform-audio-settings">
            <div className="settings-block-heading">
              <h3>{messages.platformAudio.settingsTitle}</h3>
              <p>{messages.platformAudio.settingsBody}</p>
            </div>
            {platformAudioError ? (
              <div className="settings-callout is-warning" role="alert">
                <Icon name="alert" />
                <div>
                  <strong>{messages.platformAudio.statusError}</strong>
                  <p>{platformAudioError}</p>
                </div>
              </div>
            ) : null}
            <div
              aria-live="polite"
              className={`engine-package platform-audio-package is-${platformAudioSetup.status}`}
            >
              <div className="engine-package-copy">
                <strong>
                  {messages.platformAudio.statusLabel}: {platformAudioStatusLabel}
                </strong>
                <p>{platformAudioSetup.detail}</p>
                <small>{platformAudioSetup.code}</small>
              </div>
              <div className="engine-actions platform-audio-actions">
                {snapshot.app.platform === "linux" ? (
                  <>
                    {platformAudioSetup.canInstall || platformAudioAction === "install" ? (
                      <button
                        className="button-secondary"
                        disabled={platformAudioBusy}
                        onClick={() => void runPlatformAudioAction("install")}
                        type="button"
                      >
                        {platformAudioAction === "install"
                          ? messages.platformAudio.installingRoute
                          : messages.platformAudio.installRoute}
                      </button>
                    ) : null}
                    {platformAudioSetup.canRemove || platformAudioAction === "remove" ? (
                      <button
                        className="button-secondary danger-text"
                        disabled={platformAudioBusy}
                        onClick={() => void runPlatformAudioAction("remove")}
                        type="button"
                      >
                        {platformAudioAction === "remove"
                          ? messages.platformAudio.removingRoute
                          : messages.platformAudio.removeRoute}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    {platformAudioSetup.code === "windows_vb_cable_required" ? (
                      <button
                        className="button-secondary"
                        disabled={platformAudioBusy}
                        onClick={() => void runPlatformAudioAction("download")}
                        type="button"
                      >
                        {platformAudioAction === "download"
                          ? messages.platformAudio.openingVbCable
                          : messages.platformAudio.downloadVbCable}
                      </button>
                    ) : null}
                    <button
                      className="button-secondary"
                      disabled={platformAudioBusy || !platformAudioSetup.canActivate}
                      onClick={() => void runPlatformAudioAction("activate")}
                      type="button"
                    >
                      {platformAudioAction === "activate"
                        ? messages.platformAudio.verifyingRoute
                        : messages.platformAudio.verifyRoute}
                    </button>
                  </>
                )}
                {snapshot.app.platform === "win32" ||
                !(
                  platformAudioSetup.canInstall ||
                  platformAudioSetup.canRemove ||
                  platformAudioAction === "install" ||
                  platformAudioAction === "remove"
                ) ? (
                  <button
                    className="button-secondary"
                    disabled={platformAudioBusy}
                    onClick={() => void runPlatformAudioAction("refresh")}
                    type="button"
                  >
                    {platformAudioAction === "refresh"
                      ? messages.platformAudio.checking
                      : messages.platformAudio.checkAgain}
                  </button>
                ) : null}
              </div>
            </div>
            {snapshot.app.platform === "win32" &&
            platformAudioSetup.requiresRouteAssignment ? (
              <div className="settings-footnote platform-audio-instructions">
                <Icon name="app" />
                <span>
                  {messages.platformAudio.windowsOpenAppStep}{" "}
                  {messages.platformAudio.windowsAssignStep}{" "}
                  {messages.platformAudio.windowsVerifyStep}
                </span>
              </div>
            ) : null}
            <div className="settings-footnote platform-audio-notice">
              <Icon name={snapshot.app.platform === "linux" ? "refresh" : "lock"} />
              <span>
                {snapshot.app.platform === "linux"
                  ? messages.platformAudio.linuxSettingsNotice
                  : messages.platformAudio.windowsSettingsNotice}
              </span>
            </div>
          </div>
        ) : null}
        {snapshot.app.platform === "darwin" ? (
          <div className="settings-block">
            <div className="settings-block-heading">
              <h3>{messages.settings.application.recording}</h3>
              <p>{messages.settings.application.recordingBody}</p>
            </div>
            <div className="settings-list">
              <SettingRow
                description={messages.settings.application.obsBusBody}
                title={messages.settings.application.obsBus}
              >
                <Switch
                  checked={settings.recordingBusEnabled}
                  disabled={busy}
                  label={messages.settings.application.obsBus}
                  onChange={(value) => onSetting("recordingBusEnabled", value)}
                />
              </SettingRow>
            </div>
            <div className="settings-footnote inline">
              <Icon name="info" />
              <span>{messages.settings.application.blackHoleNotice}</span>
            </div>
          </div>
        ) : null}
      </>
    );
  return (
    <>
      <div className="settings-block">
        <div className="settings-block-heading">
          <h3>
            {formatMessage(messages.settings.diagnostics.capabilityReport, {
              platform: platformName(snapshot.app.platform),
            })}
          </h3>
          <p>{messages.settings.diagnostics.capabilityBody}</p>
        </div>
        <div className="settings-list compact-list">
          <CapabilityRow
            capability={capabilities.ownedSession}
            icon="server"
            title={messages.settings.diagnostics.ownedSession}
          />
          <CapabilityRow
            capability={capabilities.desktopCapture}
            icon="microphone"
            title={messages.settings.diagnostics.processCapture}
          />
          <CapabilityRow
            capability={capabilities.suppression}
            icon="shield"
            title={messages.settings.diagnostics.originalSuppression}
          />
          <CapabilityRow
            capability={capabilities.engine}
            icon="sparkles"
            title={messages.settings.diagnostics.engineProfile}
          />
          <CapabilityRow
            capability={capabilities.output}
            icon="headphones"
            title={messages.settings.diagnostics.convertedOutput}
          />
        </div>
      </div>
      <div className="settings-block">
        <div className="settings-block-heading">
          <h3>Codex Persona Voice</h3>
          <p>
            {formatMessage(messages.settings.diagnostics.version, {
              version: snapshot.app.version,
              build: snapshot.app.packaged
                ? messages.common.installedBuild
                : messages.common.developmentBuild,
            })}
          </p>
        </div>
        <div className="about-actions">
          <button className="about-row" onClick={onOpenData} type="button">
            <Icon name="folder" />
            <span>
              <strong>{messages.settings.diagnostics.applicationData}</strong>
              <small>{messages.settings.diagnostics.applicationDataBody}</small>
            </span>
            <Icon name="chevron" />
          </button>
          <button
            className="about-row"
            onClick={onOpenRepository}
            type="button"
          >
            <Icon name="github" />
            <span>
              <strong>{messages.settings.diagnostics.repository}</strong>
              <small>miuuyy/ChatGPT-Persona-Voice</small>
            </span>
            <Icon name="chevron" />
          </button>
        </div>
      </div>
      <div className="settings-block">
        <div className="settings-block-heading">
          <h3>{messages.settings.diagnostics.telemetry}</h3>
          <p>{messages.settings.diagnostics.telemetryBody}</p>
        </div>
        <div className="diagnostic-meta">
          <span>{messages.settings.diagnostics.worker}</span>
          <code>
            {workerStateLabel}
            {snapshot.engineDiagnostics.active ? ` · ${messages.common.active}` : ""}
          </code>
          <span>{messages.settings.diagnostics.profile}</span>
          <code>
            {snapshot.engineDiagnostics.blockMs} ms ·{" "}
            {formatMessage(messages.settings.diagnostics.steps, {
              count: new Intl.NumberFormat(locale).format(snapshot.engineDiagnostics.steps),
            })}
          </code>
          <span>{messages.settings.diagnostics.runtimeProfile}</span>
          <code>
            {snapshot.engineDiagnostics.runtimeProfile ?? messages.common.notReported}
            {snapshot.engineDiagnostics.backend
              ? ` · ${snapshot.engineDiagnostics.backend}`
              : ""}
          </code>
          <span>{messages.settings.diagnostics.accelerator}</span>
          <code>
            {snapshot.engineDiagnostics.cudaDeviceName ??
              snapshot.engineDiagnostics.device ??
              messages.common.notReported}
          </code>
          <span>{messages.settings.diagnostics.lastInference}</span>
          <code>
            {snapshot.engineDiagnostics.lastInferenceMs === null
              ? messages.settings.diagnostics.noConvertedBlock
              : `${snapshot.engineDiagnostics.lastInferenceMs.toFixed(1)} ms`}
          </code>
          <span>{messages.settings.diagnostics.acceleratorMemory}</span>
          <code>
            {(snapshot.engineDiagnostics.device === "cuda"
              ? snapshot.engineDiagnostics.cudaAllocatedBytes
              : snapshot.engineDiagnostics.mpsCurrentAllocatedBytes) === null
              ? messages.common.notReported
              : formatBytes(
                  snapshot.engineDiagnostics.device === "cuda"
                    ? snapshot.engineDiagnostics.cudaAllocatedBytes!
                    : snapshot.engineDiagnostics.mpsCurrentAllocatedBytes!,
                  locale,
                )}
          </code>
          <span>{messages.settings.diagnostics.acceleratorReserved}</span>
          <code>
            {(snapshot.engineDiagnostics.device === "cuda"
              ? snapshot.engineDiagnostics.cudaReservedBytes
              : snapshot.engineDiagnostics.mpsDriverAllocatedBytes) === null
              ? messages.common.notReported
              : formatBytes(
                  snapshot.engineDiagnostics.device === "cuda"
                    ? snapshot.engineDiagnostics.cudaReservedBytes!
                    : snapshot.engineDiagnostics.mpsDriverAllocatedBytes!,
                  locale,
                )}
          </code>
          <span>{messages.settings.diagnostics.convertedBlocks}</span>
          <code>{snapshot.engineDiagnostics.convertedBlocks}</code>
        </div>
      </div>
      <div className="diagnostic-meta">
        <span>{messages.settings.diagnostics.platform}</span>
        <code>
          {snapshot.app.platform}{" "}
          {capabilities.macVersion || capabilities.release}
        </code>
        <span>{messages.settings.diagnostics.codexCli}</span>
        <code>
          {capabilities.codex.detected
            ? capabilities.codex.executable
            : messages.common.notDetected}
        </code>
      </div>
    </>
  );
}
