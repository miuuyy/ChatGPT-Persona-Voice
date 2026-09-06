import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, VoiceMark } from "./icons";
import {
  formatMessage,
  I18nProvider,
  messagesFor,
} from "./i18n";
import type {
  AudioSource,
  HistoryEntry,
  LauncherSnapshot,
  TabId,
  VoiceBridge,
  VoicePreset,
} from "./types";
import { ConfirmClear } from "./components/ConfirmClear";
import { EmptyBridge, Sidebar, WorkspaceToolbar } from "./components/AppShell";
import { Onboarding } from "./components/Onboarding";
import { errorMessage, type SettingsSectionId } from "./lib/presentation";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const api = window.codexPersonaVoice;
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("audio");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return (
        window.localStorage.getItem("persona-voice.sidebar-collapsed") ===
        "true"
      );
    } catch {
      return false;
    }
  });
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    message: string;
    success: boolean;
  } | null>(null);
  const [pendingActions, setPendingActions] = useState(0);
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const audioRef = useRef<{
    audio: HTMLAudioElement;
    url: string;
    key: string;
  } | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const unsubSnapshot = api.onSnapshot((value) => {
      if (alive) setSnapshot(value);
    });
    const unsubRuntime = api.onRuntime((runtime) => {
      if (alive)
        setSnapshot((current) => (current ? { ...current, runtime } : current));
    });
    const unsubUpdate = api.onUpdateState((update) => {
      if (alive)
        setSnapshot((current) => (current ? { ...current, update } : current));
    });
    void api
      .snapshot()
      .then((value) => {
        if (alive) setSnapshot(value);
      })
      .catch((error) => {
        if (alive) setLoadingError(errorMessage(error));
      });
    return () => {
      alive = false;
      unsubSnapshot();
      unsubRuntime();
      unsubUpdate();
      if (audioRef.current) {
        audioRef.current.audio.pause();
        URL.revokeObjectURL(audioRef.current.url);
        audioRef.current = null;
      }
    };
  }, [api]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "persona-voice.sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      } else if (command && event.key === ",") {
        event.preventDefault();
        setActiveTab("settings");
      } else if (command && event.key === "1") {
        event.preventDefault();
        setActiveTab("home");
      } else if (command && event.key === "2") {
        event.preventDefault();
        setActiveTab("history");
      } else if (event.key === "Escape" && confirmClear) {
        setConfirmClear(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmClear]);

  useEffect(() => {
    if (
      !api ||
      !snapshot ||
      snapshot.runtime.state !== "stopped" ||
      snapshot.runtime.ready
    )
      return;
    if (
      !snapshot.capabilities.desktopCapture.possible ||
      !snapshot.capabilities.suppression.possible
    )
      return;
    let active = true;
    const timer = window.setInterval(() => {
      void api
        .refreshReadiness()
        .then(() => api.snapshot())
        .then((value) => {
          if (active) setSnapshot(value);
        })
        .catch(() => {});
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    api,
    snapshot?.runtime.state,
    snapshot?.runtime.ready,
    snapshot?.capabilities.desktopCapture.possible,
    snapshot?.capabilities.suppression.possible,
  ]);

  const blockers = useMemo(
    () => snapshot?.runtime.checks.filter((check) => !check.ready) ?? [],
    [snapshot],
  );
  const busy = pendingActions > 0;

  if (!api) return <EmptyBridge />;
  if (loadingError)
    return (
      <main className="bridge-error">
        <span className="bridge-mark is-error">
          <Icon name="alert" />
        </span>
        <h1>Launcher could not load · ランチャーを読み込めませんでした · 启动器无法加载</h1>
        <p>{loadingError}</p>
      </main>
    );
  if (!snapshot)
    return (
      <main className="loading-screen">
        <span className="loading-mark">
          <VoiceMark />
        </span>
        <span>Loading · 読み込み中 · 正在加载</span>
      </main>
    );
  const bridge: VoiceBridge = api;

  if (snapshot.settings.uiLocale === null || !snapshot.onboarding.complete) {
    return (
      <Onboarding
        bridge={bridge}
        onChange={(onboarding) =>
          setSnapshot((current) => current ? { ...current, onboarding } : current)
        }
        onLocaleChange={(settings) =>
          setSnapshot((current) => current ? { ...current, settings } : current)
        }
        snapshot={snapshot}
      />
    );
  }
  const locale = snapshot.settings.uiLocale;
  const messages = messagesFor(locale);

  async function run(action: () => Promise<unknown>, success?: string) {
    setPendingActions((count) => count + 1);
    setNotice(null);
    try {
      await action();
      setSnapshot(await bridge.snapshot());
      if (success) setNotice({ message: success, success: true });
    } catch (error) {
      const message = errorMessage(error);
      if (!/(?:voice relay startup|engine installation) was cancelled/i.test(message))
        setNotice({ message, success: false });
    } finally {
      setPendingActions((count) => Math.max(0, count - 1));
    }
  }

  function openSettings(section: SettingsSectionId) {
    setSettingsSection(section);
    setActiveTab("settings");
  }

  async function discoverSources() {
    setSourceLoading(true);
    setNotice(null);
    try {
      const result = await bridge.listSources();
      setSources(result.sources);
      setSnapshot(await bridge.snapshot());
      if (result.sources.length === 0)
        setNotice({
          message: messages.app.noSources,
          success: false,
        });
    } catch (error) {
      setNotice({ message: errorMessage(error), success: false });
    } finally {
      setSourceLoading(false);
    }
  }

  async function installUpdate() {
    setPendingActions((count) => count + 1);
    setNotice(null);
    try {
      await bridge.installUpdate();
    } catch (error) {
      setNotice({ message: errorMessage(error), success: false });
      setPendingActions((count) => Math.max(0, count - 1));
    }
  }

  function stopPlayback() {
    if (!audioRef.current) return;
    audioRef.current.audio.pause();
    URL.revokeObjectURL(audioRef.current.url);
    audioRef.current = null;
    setPlayingKey(null);
  }

  async function playAudio(
    key: string,
    load: () => Promise<{ data: Uint8Array; mimeType: string }>,
  ) {
    if (audioRef.current?.key === key) {
      stopPlayback();
      return;
    }
    stopPlayback();
    try {
      const result = await load();
      const bytes = new Uint8Array(result.data);
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer], { type: result.mimeType }),
      );
      const audio = new Audio(url);
      audioRef.current = { audio, url, key };
      setPlayingKey(key);
      const finish = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current?.url === url) audioRef.current = null;
        setPlayingKey((current) => (current === key ? null : current));
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (error) {
      setPlayingKey(null);
      setNotice({ message: errorMessage(error), success: false });
    }
  }

  return (
    <I18nProvider locale={locale}>
      <div
        className="app-root"
        data-platform={snapshot.app.platform}
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      >
        <div className="app-titlebar draggable" />
        <div
          aria-hidden={confirmClear || undefined}
          className="app-shell"
          inert={confirmClear || undefined}
        >
        <Sidebar
          active={activeTab}
          collapsed={sidebarCollapsed}
          onSelect={setActiveTab}
          onInstallUpdate={() => void installUpdate()}
          onToggle={() => setSidebarCollapsed((value) => !value)}
          snapshot={snapshot}
        />
        <main className="workspace">
          <WorkspaceToolbar active={activeTab} snapshot={snapshot} />
          {activeTab === "home" ? (
            <HomePage
              busy={busy}
              onOpenSettings={openSettings}
              onRefresh={() => void run(() => bridge.refreshReadiness())}
              onStart={() => void run(() => bridge.start())}
              onStop={() => void run(() => bridge.stop(), messages.app.routeRestored)}
              snapshot={snapshot}
            />
          ) : null}
          {activeTab === "history" ? (
            <HistoryPage
              onOpenSettings={openSettings}
              onPlay={(entry: HistoryEntry) =>
                void playAudio(`history:${entry.id}`, () =>
                  bridge.historyAudio(entry.id),
                )
              }
              onRequestClear={() => setConfirmClear(true)}
              playingKey={playingKey}
              snapshot={snapshot}
            />
          ) : null}
          {activeTab === "settings" ? (
            <SettingsPage
              busy={busy || snapshot.runtime.state !== "stopped"}
              onAutostart={(value) =>
                void run(() => bridge.setAutostart(value))
              }
              onDiscoverSources={() => void discoverSources()}
              onCancelEngineInstall={() =>
                void bridge.cancelEngineInstall().then(() => bridge.snapshot()).then(setSnapshot)
              }
              onInstallEngine={() =>
                void run(() => bridge.installEngine(), messages.app.engineInstalled)
              }
              onMode={(mode) => void run(() => bridge.selectSourceMode(mode))}
              onOpenData={() => void run(() => bridge.openDataDirectory())}
              onOpenRepository={() => void run(() => bridge.openRepository())}
              onRemoveEngine={() =>
                void run(() => bridge.removeEngine(), messages.app.engineRemoved)
              }
              onPreviewVoice={(voice: VoicePreset) =>
                void playAudio(`voice:${voice.id}`, () =>
                  bridge.voiceSample(voice.id),
                )
              }
              onRequestClear={() => setConfirmClear(true)}
              onSection={setSettingsSection}
              onSelectSource={(source) =>
                void run(() =>
                  bridge.selectSource(
                    source ? { id: source.id, name: source.name } : null,
                  ),
                )
              }
              onSelectVoice={(id) =>
                void run(() => bridge.selectVoice(id), messages.app.voiceSelected)
              }
              onSelectModel={(id) => void run(() => bridge.selectModel(id))}
              onSetting={(key, value) =>
                void run(() => bridge.setSetting(key, value))
              }
              onVoiceTerms={(voice: VoicePreset) =>
                void run(() => bridge.openVoiceTerms(voice.id))
              }
              playingKey={playingKey}
              section={settingsSection}
              snapshot={snapshot}
              sourceLoading={sourceLoading}
              sources={sources}
            />
          ) : null}
        </main>
        </div>
      {notice ? (
        <div
          aria-live="polite"
          className={`toast${notice.success ? " tone-success" : ""}`}
        >
          <Icon name={notice.success ? "check" : "alert"} />
          <span>{notice.message}</span>
        </div>
      ) : null}
      {confirmClear ? (
        <ConfirmClear
          busy={busy}
          count={snapshot.history.length}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() =>
            void run(async () => {
              await bridge.clearHistory();
              setConfirmClear(false);
              stopPlayback();
            }, messages.app.historyCleared)
          }
        />
      ) : null}
      <span className="sr-only">
        {formatMessage(
          blockers.length === 1
            ? messages.app.blockedStagesOne
            : messages.app.blockedStagesOther,
          { count: new Intl.NumberFormat(locale).format(blockers.length) },
        )}
      </span>
      </div>
    </I18nProvider>
  );
}
