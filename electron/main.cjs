"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const { createHistoryStore } = require("./history-store.cjs");
const { ConvertedHistoryRecorder } = require("./history-recorder.cjs");
const {
  EngineInstaller,
  resolveEngineInstallerPaths,
  resolveEngineStoragePaths,
} = require("./engine-installer.cjs");
const { appendBoundedLine, createLogger } = require("./logging.cjs");
const { MacAudioOutput } = require("./macos-audio-output.cjs");
const { MacProcessRoute } = require("./macos-process-route.cjs");
const { LinuxAudioOutput } = require("./linux-audio-output.cjs");
const linuxAudioPolicy = require("./linux-audio-policy.cjs");
const { LinuxProcessRoute } = require("./linux-process-route.cjs");
const { resolveNativeHelperPath } = require("./native-helper.cjs");
const { PipelineRuntime } = require("./pipeline-runtime.cjs");
const { PlatformAudioSetupController } = require("./platform-audio-setup.cjs");
const { probePlatformCapabilities } = require("./platform-capabilities.cjs");
const { createRelayPowerController } = require("./relay-power.cjs");
const { OBS_RECORDING_DEVICE_UID, createRuntimeAdapters } = require("./runtime-adapters.cjs");
const { StoppedMutationGate } = require("./stopped-mutation-gate.cjs");
const { SeedVcEngine, resolveSeedVcPaths } = require("./seed-vc-engine.cjs");
const { listAudioSources } = require("./source-discovery.cjs");
const { requireSourceMode } = require("./source-mode.cjs");
const { createStateStore } = require("./state-store.cjs");
const { createUpdateController } = require("./update.cjs");
const { VoiceCatalog } = require("./voice-catalog.cjs");
const { createWindowsIntegration } = require("./windows-integration.cjs");
const { MIN_WINDOW_BOUNDS, readWindowState, trackWindowState } = require("./window-state.cjs");

const PRODUCT_NAME = "Codex Persona Voice";
const APP_ID = "dev.miuuyy.codexpersonavoice";
const REPOSITORY_URL = "https://github.com/miuuyy/ChatGPT-Persona-Voice";
const X_URL = "https://x.com/miu21590";
const WINDOWS_VB_CABLE_URL = "https://vb-audio.com/Cable/";
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const EXPECTED_DEV_SERVER_URL = "http://127.0.0.1:4178";
const requestedDevServerUrl = process.env.VITE_DEV_SERVER_URL?.trim() || null;
const devServerUrl = !app.isPackaged && requestedDevServerUrl === EXPECTED_DEV_SERVER_URL
  ? EXPECTED_DEV_SERVER_URL
  : null;
const invalidDevServerUrl = !app.isPackaged && requestedDevServerUrl !== null && devServerUrl === null;
const isDev = devServerUrl !== null;

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join("; ");

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) {
    throw new Error("CODEX_PERSONA_VOICE_DATA_DIR must be an absolute path or begin with ~/");
  }
  return path.normalize(value);
}

app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
const configuredUserData = process.env.CODEX_PERSONA_VOICE_DATA_DIR?.trim();
const userDataDirectory = configuredUserData
  ? resolveUserPath(configuredUserData)
  : path.join(app.getPath("appData"), PRODUCT_NAME);
fs.mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
try { fs.chmodSync(userDataDirectory, 0o700); } catch {}
app.setPath("userData", userDataDirectory);
app.setAppLogsPath(path.join(userDataDirectory, "logs"));

let mainWindow = null;
let tray = null;
let stateStore = null;
let historyStore = null;
let historyRecorder = null;
let runtime = null;
let capabilities = null;
let logger = null;
let cleanupTimer = null;
let diagnosticsBroadcastTimer = null;
let voiceCatalog = null;
let voiceEngine = null;
let engineInstaller = null;
let quitting = false;
let quitRequested = false;
let quitPromise = null;
let lastRuntimeState = null;
let stoppedMutationGate = null;
let updateController = null;
let relayPower = null;
let platformAudioSetup = null;
let windowsIntegration = null;
let windowsRecoveryTimer = null;

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function rendererNavigationAllowed(value) {
  let target;
  try { target = new URL(value); } catch { return false; }
  if (isDev) {
    try { return target.origin === new URL(devServerUrl).origin; }
    catch { return false; }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function createWindow({ startHidden = false } = {}) {
  const isMac = process.platform === "darwin";
  const statePath = path.join(userDataDirectory, "window-state.json");
  const saved = readWindowState(statePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: saved.bounds.width,
    height: saved.bounds.height,
    ...(Number.isFinite(saved.bounds.x) && Number.isFinite(saved.bounds.y)
      ? { x: saved.bounds.x, y: saved.bounds.y }
      : {}),
    minWidth: Math.max(MIN_WINDOW_BOUNDS.width, 800),
    minHeight: Math.max(MIN_WINDOW_BOUNDS.height, 620),
    title: PRODUCT_NAME,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: { color: "#181818", symbolColor: "#a8a8a8", height: 46 },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      devTools: isDev,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  const guardNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    logger.warn("renderer.navigation_blocked", { url });
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error("renderer.process_gone", { reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on("unresponsive", () => logger.error("renderer.unresponsive"));
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().settings.keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.on("focus", () => {
    if (runtime?.snapshot().state !== "stopped") return;
    void refreshReadiness().catch((error) => {
      logger.warn("runtime.readiness_refresh_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("voice:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!Number.isFinite(saved.bounds.x)) window.center();
    if (saved.maximized) window.maximize();
    if (saved.fullscreen) window.setFullScreen(true);
    if (!startHidden) window.show();
  });
  trackWindowState(window, statePath, (error) => {
    logger.warn("window.state_write_failed", { message: error instanceof Error ? error.message : String(error) });
  });
  return window;
}

function configureSessionSecurity() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    logger.warn("renderer.permission_denied", { permission });
    callback(false);
  });
  activeSession.setDevicePermissionHandler(() => false);
  if (!isDev) {
    activeSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [PRODUCTION_CSP],
        },
      });
    });
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trayImage() {
  const image = nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

const TRAY_COPY = Object.freeze({
  und: { open: "Persona Voice", active: "●", quit: "Quit / 終了 / 退出" },
  en: { open: "Open Persona Voice", active: "Voice relay active", quit: "Quit" },
  ja: { open: "Persona Voice を開く", active: "音声リレー実行中", quit: "終了" },
  "zh-CN": { open: "打开 Persona Voice", active: "语音中继运行中", quit: "退出" },
});

const WINDOWS_RESTORE_COPY = Object.freeze({
  und: {
    title: "Restore the Windows audio route",
    message: "Restore ChatGPT/Codex output before quitting Persona Voice.",
    detail: "In Windows Settings > System > Sound > Volume mixer, set the selected app Output back to Default or your physical listening device. Then confirm here.",
    buttons: ["Cancel", "Open Volume Mixer", "I've restored it"],
  },
  en: {
    title: "Restore the Windows audio route",
    message: "Restore ChatGPT/Codex output before quitting Persona Voice.",
    detail: "In Windows Settings > System > Sound > Volume mixer, set the selected app Output back to Default or your physical listening device. Then confirm here.",
    buttons: ["Cancel", "Open Volume Mixer", "I've restored it"],
  },
  ja: {
    title: "Windows の音声ルートを戻す",
    message: "Persona Voice を終了する前に ChatGPT/Codex の出力先を戻してください。",
    detail: "Windows 設定 > システム > サウンド > 音量ミキサーで、対象アプリの出力を「既定」または物理スピーカーに戻し、ここで確認してください。",
    buttons: ["キャンセル", "音量ミキサーを開く", "元に戻しました"],
  },
  "zh-CN": {
    title: "恢复 Windows 音频路由",
    message: "退出 Persona Voice 前，请恢复 ChatGPT/Codex 的输出设备。",
    detail: "在 Windows 设置 > 系统 > 声音 > 音量混合器中，将所选应用的输出改回“默认”或物理扬声器，然后在此确认。",
    buttons: ["取消", "打开音量混合器", "已恢复"],
  },
});

function refreshTray() {
  if (!tray) return;
  const locale = stateStore?.read().settings.uiLocale;
  const copy = TRAY_COPY[locale ?? "und"];
  if (!copy) throw new Error(`Unsupported tray locale: ${String(locale)}`);
  const snapshot = runtime?.snapshot();
  const active = snapshot?.suppressionHeld === true ||
    ["engaging", "running"].includes(snapshot?.state);
  tray.setToolTip(active ? `${PRODUCT_NAME} — ${copy.active}` : PRODUCT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.open, click: showMainWindow },
    ...(active ? [{ label: copy.active, enabled: false }, { type: "separator" }] : [{ type: "separator" }]),
    { label: copy.quit, click: () => { void requestQuit(); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    refreshTray();
    tray.on("click", showMainWindow);
    return true;
  } catch (error) {
    logger.warn("tray.unavailable", { message: error instanceof Error ? error.message : String(error) });
    tray = null;
    return false;
  }
}

function capabilitiesWithPlatformAudioSetup() {
  const setup = platformAudioSetup?.getState();
  if (!setup || !["linux", "win32"].includes(process.platform)) return capabilities;
  const ready = setup.status === "ready";
  return {
    ...capabilities,
    suppression: {
      possible: true,
      ready,
      code: ready ? "ready" : setup.code,
      detail: ready ? setup.detail : setup.detail,
    },
  };
}

function windowsStandbyHandlers() {
  return {
    onError(error) {
      platformAudioSetup?.routeError(error);
      logger?.error("windows.standby_route_failed", {
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error?.code === "source_process_exited") scheduleWindowsStandbyRecovery();
      void (async () => {
        if (runtime?.snapshot().state === "stopped") {
          await runtime.inspect(stateStore.read().settings);
        }
        await broadcastSnapshot();
      })().catch(() => {});
    },
    onStatus(status) {
      logger?.info("windows.standby_route_state", {
        state: status?.state,
        reason: status?.reason,
      });
    },
  };
}

function scheduleWindowsStandbyRecovery() {
  if (!windowsIntegration || windowsRecoveryTimer || quitRequested || quitting) return;
  windowsRecoveryTimer = setTimeout(async () => {
    windowsRecoveryTimer = null;
    if (quitRequested || quitting || !windowsIntegration) return;
    try {
      const settings = stateStore.read().settings;
      const processes = await windowsIntegration.rawProcessRoute.resolveProcesses(settings);
      if (!Array.isArray(processes?.pids) || processes.pids.length === 0) {
        scheduleWindowsStandbyRecovery();
        return;
      }
      const lifecycle = windowsIntegration.routeLifecycle.snapshot();
      if (lifecycle.routeHeld && lifecycle.errorCode === "source_process_exited") {
        await windowsIntegration.routeLifecycle.recoverStandbyAfterSourceRestart(
          settings,
          windowsStandbyHandlers(),
        );
      } else if (!lifecycle.routeHeld) {
        const activated = await platformAudioSetup.activate(settings, windowsStandbyHandlers());
        if (activated.status !== "ready") {
          const error = new Error(activated.detail);
          error.code = activated.code;
          throw error;
        }
      } else if (!lifecycle.standbyActive) {
        throw new Error("The retained Windows route cannot enter standby automatically");
      }
      await platformAudioSetup.inspect(settings);
      await runtime.inspect(settings);
      await broadcastSnapshot();
      logger.info("windows.standby_route_recovered");
    } catch (error) {
      platformAudioSetup?.routeError(error);
      logger?.warn("windows.standby_route_recovery_failed", {
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      });
      await broadcastSnapshot().catch(() => {});
    }
  }, 1_000);
  windowsRecoveryTimer.unref?.();
}

function requireMutableSourceRoute() {
  if (windowsIntegration?.routeLifecycle.snapshot().manualRestoreRequired) {
    throw windowsIntegration.routeLifecycle.manualRestoreError();
  }
}

async function buildSnapshot() {
  const state = stateStore.read();
  const runtimeSnapshot = runtime.snapshot();
  const engineCheck = runtimeSnapshot.checks.find((check) => check.id === "engine");
  return {
    app: {
      name: PRODUCT_NAME,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    },
    onboarding: state.onboarding,
    update: updateController?.getState() ?? { status: "disabled" },
    settings: state.settings,
    autostart: getAutostart(app),
    capabilities: engineCheck
      ? { ...capabilitiesWithPlatformAudioSetup(), engine: {
          ready: engineCheck.ready,
          possible: voiceEngine.diagnostics().runtimeProfile !== null,
          code: engineCheck.code,
          detail: engineCheck.detail,
        } }
      : capabilitiesWithPlatformAudioSetup(),
    platformAudioSetup: platformAudioSetup.getState(),
    runtime: runtimeSnapshot,
    engineInstallation: engineInstaller.getState(),
    engineDiagnostics: voiceEngine.diagnostics(),
    voices: voiceCatalog.list(),
    history: historyStore.list(),
  };
}

async function broadcastSnapshot() {
  send("voice:snapshot-changed", await buildSnapshot());
}

function scheduleDiagnosticsBroadcast() {
  if (diagnosticsBroadcastTimer || quitting) return;
  diagnosticsBroadcastTimer = setTimeout(() => {
    diagnosticsBroadcastTimer = null;
    void broadcastSnapshot().catch((error) => {
      logger.warn("engine.diagnostics_broadcast_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, 1_000);
  diagnosticsBroadcastTimer.unref?.();
}

async function refreshReadiness({ broadcast = true } = {}) {
  if (runtime.snapshot().state !== "stopped") return runtime.snapshot();
  const result = await runtime.inspect(stateStore.read().settings);
  if (broadcast) await broadcastSnapshot();
  return result;
}

function registerIpc() {
  const allowedDuringQuit = new Set(["voice:snapshot", "voice:window-state"]);
  const handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("IPC sender is not trusted");
      if (quitRequested && !allowedDuringQuit.has(channel)) {
        throw new Error("The launcher is shutting down and cannot accept new work");
      }
      try { return await listener(event, ...args); }
      catch (error) {
        logger.error("ipc.failed", {
          channel,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  };

  handle("voice:snapshot", () => buildSnapshot());
  handle("voice:open-social", async (_event, target) => {
    const url = target === "github" ? REPOSITORY_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await shell.openExternal(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    const state = stateStore.setOnboarding(patch);
    await broadcastSnapshot();
    return state.onboarding;
  });
  handle("voice:complete-onboarding", async () => {
    const state = stateStore.setOnboarding({ complete: true });
    logger.info("launcher.onboarding_completed");
    await broadcastSnapshot();
    return state.onboarding;
  });
  handle("voice:refresh-readiness", () => refreshReadiness());
  handle("voice:platform-audio-setup-refresh", async () => {
    const result = await platformAudioSetup.inspect(stateStore.read().settings);
    if (runtime.snapshot().state === "stopped") await runtime.inspect(stateStore.read().settings);
    await broadcastSnapshot();
    return result;
  });
  handle("voice:platform-audio-setup-open-download", async () => {
    if (process.platform !== "win32") {
      throw new Error("VB-CABLE setup is available only on Windows");
    }
    await shell.openExternal(WINDOWS_VB_CABLE_URL);
    return true;
  });
  handle("voice:platform-audio-setup-install", async () => {
    return stoppedMutationGate.run("platform audio setup", async () => {
      const result = await platformAudioSetup.install(stateStore.read().settings);
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    });
  });
  handle("voice:platform-audio-setup-activate", async () => {
    return stoppedMutationGate.run("platform audio route activation", async () => {
      if (!windowsIntegration) throw new Error("Windows audio route activation is unavailable");
      const result = await platformAudioSetup.activate(
        stateStore.read().settings,
        windowsStandbyHandlers(),
      );
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    });
  });
  handle("voice:platform-audio-setup-remove", async () => {
    return stoppedMutationGate.run("platform audio setup removal", async () => {
      const result = await platformAudioSetup.remove();
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    });
  });
  handle("voice:engine-install", async () => {
    return stoppedMutationGate.run("engine package installation", async () => {
      await voiceEngine.shutdown();
      const result = await engineInstaller.install();
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    });
  });
  handle("voice:engine-install-cancel", () => engineInstaller.cancel());
  handle("voice:engine-remove", async () => {
    return stoppedMutationGate.run("engine package removal", async () => {
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Remove voice engine?",
        message: "Remove the local Seed-VC engine package?",
        detail: "The launcher and voice references stay installed. Reinstalling the engine requires another download.",
        buttons: ["Cancel", "Remove engine"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return engineInstaller.getState();
      await voiceEngine.shutdown();
      const result = await engineInstaller.remove();
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    });
  });
  handle("voice:set-setting", async (_event, key, value) => {
    return stoppedMutationGate.run("settings update", async () => {
      if ([
        "launchAtLogin",
        "sourceMode",
        "sourceId",
        "sourceName",
        "selectedVoiceId",
        "selectedVoiceName",
        "windowsManualRouteConfigured",
      ].includes(key)) {
        throw new Error(`Use the dedicated operation for setting ${String(key)}`);
      }
      const state = stateStore.setSetting(key, value);
      if (key === "uiLocale" || key === "keepRunningOnClose") refreshTray();
      if (key === "retentionHours") historyStore.cleanup({ retentionHours: state.settings.retentionHours });
      await runtime.inspect(state.settings);
      await broadcastSnapshot();
      return state.settings;
    });
  });
  handle("voice:set-autostart", async (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Autostart must be a boolean");
    const desired = enabled;
    const result = setAutostart(app, desired);
    stateStore.setSetting("launchAtLogin", desired);
    await broadcastSnapshot();
    return result;
  });
  handle("voice:select-source-mode", async (_event, mode) => {
    return stoppedMutationGate.run("source-mode update", async () => {
      requireMutableSourceRoute();
      requireSourceMode(mode, capabilitiesWithPlatformAudioSetup());
      const current = stateStore.read().settings;
      stateStore.replaceSettings({ ...current, sourceMode: mode });
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return stateStore.read().settings;
    });
  });
  handle("voice:select-source", async (_event, source) => {
    return stoppedMutationGate.run("source selection", async () => {
      requireMutableSourceRoute();
      if (source === null) {
        const current = stateStore.read().settings;
        stateStore.replaceSettings({ ...current, sourceId: null, sourceName: null });
      } else {
        if (!source || typeof source.id !== "string" || typeof source.name !== "string") {
          throw new Error("A discovered source id and name are required");
        }
        const discovered = await listAudioSources();
        const selected = discovered.sources.find((candidate) => candidate.id === source.id && candidate.name === source.name);
        if (!selected) throw new Error("The selected audio source is no longer available");
        const current = stateStore.read().settings;
        stateStore.replaceSettings({ ...current, sourceId: selected.id, sourceName: selected.name });
      }
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return stateStore.read().settings;
    });
  });
  handle("voice:list-sources", async () => {
    const result = await listAudioSources();
    if (runtime.snapshot().state === "stopped") await runtime.inspect(stateStore.read().settings);
    await broadcastSnapshot();
    return result;
  });
  handle("voice:select-voice", async (_event, id) => {
    return stoppedMutationGate.run("voice selection", async () => {
      const voice = voiceCatalog.resolve(id);
      await voiceEngine.shutdown();
      const current = stateStore.read().settings;
      stateStore.replaceSettings({
        ...current,
        selectedVoiceId: voice.id,
        selectedVoiceName: voice.name,
      });
      await runtime.inspect(stateStore.read().settings);
      await broadcastSnapshot();
      return stateStore.read().settings;
    });
  });
  handle("voice:voice-sample", (_event, id) => {
    const result = voiceCatalog.sample(id);
    return { voice: result.voice, data: result.data, mimeType: result.mimeType };
  });
  handle("voice:open-voice-terms", async (_event, id) => {
    const voice = voiceCatalog.resolve(id);
    await shell.openExternal(voice.termsUrl);
    return true;
  });
  handle("voice:start", async () => {
    stoppedMutationGate.assertCanStart();
    const setup = platformAudioSetup.getState();
    if (["linux", "win32"].includes(process.platform) && setup.status !== "ready") {
      const error = new Error(setup.detail);
      error.code = setup.code;
      throw error;
    }
    historyRecorder.discard();
    relayPower.start();
    try {
      const result = await runtime.start(stateStore.read().settings);
      await broadcastSnapshot();
      return result;
    } catch (error) {
      historyRecorder.discard();
      if (runtime.snapshot().state === "stopped") relayPower.stop();
      throw error;
    }
  });
  handle("voice:stop", async () => {
    const result = await runtime.stop();
    relayPower.stop();
    historyRecorder.flush();
    await broadcastSnapshot();
    return result;
  });
  handle("voice:history-audio", (_event, id) => {
    const result = historyStore.audio(id);
    return { entry: result.entry, data: result.data, mimeType: result.mimeType };
  });
  handle("voice:history-clear", async () => {
    historyRecorder.discard();
    const result = historyStore.clear();
    await broadcastSnapshot();
    return result;
  });
  handle("voice:open-data-directory", async () => {
    const error = await shell.openPath(userDataDirectory);
    if (error) throw new Error(`Could not open the data directory: ${error}`);
    return true;
  });
  handle("voice:open-repository", async () => {
    await shell.openExternal(REPOSITORY_URL);
    return true;
  });
  handle("voice:update-install", async () => {
    if (!updateController) throw new Error("Application updates are unavailable");
    const launch = await updateController.beginInstall();
    const stopped = await requestQuit();
    if (!stopped) {
      updateController.cancelInstall(launch);
      throw new Error("The voice relay could not stop safely, so the update was cancelled");
    }
    return true;
  });
  handle("voice:window-state", (event) => windowStateSnapshot(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.on("voice:window-control", (event, action) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

function startCleanupTimer() {
  const run = () => {
    try {
      const { removed } = historyStore.cleanup({ retentionHours: stateStore.read().settings.retentionHours });
      if (removed > 0) {
        logger.info("history.cleaned", { removed });
        void broadcastSnapshot();
      }
    } catch (error) {
      logger.error("history.cleanup_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };
  run();
  cleanupTimer = setInterval(run, 5 * 60 * 1000);
  cleanupTimer.unref?.();
}

async function restoreWindowsRouteBeforeQuit() {
  if (!windowsIntegration?.routeLifecycle.snapshot().manualRestoreRequired) return true;
  const pending = await windowsIntegration.routeLifecycle.beginManualRestore();
  if (!pending.required) return true;
  showMainWindow();
  const locale = stateStore.read().settings.uiLocale ?? "und";
  const copy = WINDOWS_RESTORE_COPY[locale] || WINDOWS_RESTORE_COPY.und;
  for (;;) {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: copy.buttons,
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response === 0) {
      await windowsIntegration.routeLifecycle.cancelManualRestore();
      return false;
    }
    if (confirmation.response === 1) {
      await shell.openExternal("ms-settings:apps-volume");
      continue;
    }
    await windowsIntegration.routeLifecycle.completeManualRestore({ userConfirmed: true });
    stateStore.setSetting("windowsManualRouteConfigured", false);
    return true;
  }
}

function requestQuit() {
  if (quitting) return Promise.resolve(true);
  if (quitPromise) return quitPromise;
  quitRequested = true;
  quitPromise = (async () => {
    try {
      await engineInstaller?.shutdown();
      await stoppedMutationGate?.waitForIdle();
      const runtimeState = runtime?.snapshot().state;
      if (runtimeState && runtimeState !== "stopped") await runtime.stop();
      if (!await restoreWindowsRouteBeforeQuit()) return false;
      await voiceEngine?.shutdown();
      relayPower?.stop();
      historyRecorder?.flush();
      quitting = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      if (diagnosticsBroadcastTimer) clearTimeout(diagnosticsBroadcastTimer);
      diagnosticsBroadcastTimer = null;
      if (windowsRecoveryTimer) clearTimeout(windowsRecoveryTimer);
      windowsRecoveryTimer = null;
      tray?.destroy();
      tray = null;
      mainWindow?.destroy();
      app.quit();
      return true;
    } catch (error) {
      showMainWindow();
      dialog.showErrorBox("Could not stop the voice relay", error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (!quitting) {
        quitRequested = false;
        quitPromise = null;
      }
    }
  })();
  return quitPromise;
}

async function start() {
  if (invalidDevServerUrl) {
    throw new Error(`VITE_DEV_SERVER_URL must be exactly ${EXPECTED_DEV_SERVER_URL} in development`);
  }
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    app.quit();
    return;
  }
  app.on("second-instance", showMainWindow);
  await app.whenReady();
  nativeTheme.themeSource = "dark";
  if (isDev && process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(APP_ICON_PATH);
    if (dockIcon.isEmpty()) throw new Error(`Development app icon is invalid: ${APP_ICON_PATH}`);
    app.dock.setIcon(dockIcon);
  }
  logger = createLogger(path.join(app.getPath("logs"), "launcher.jsonl"), (record) => send("voice:log", record));
  relayPower = createRelayPowerController(powerSaveBlocker);
  configureSessionSecurity();
  stateStore = createStateStore(path.join(userDataDirectory, "launcher-state.json"));
  const updaterRuntimePath = app.isPackaged
    ? path.join(process.resourcesPath, "updater-runtime", process.platform === "win32" ? "bun.exe" : "bun")
    : null;
  const atomicSwapPath = app.isPackaged && process.platform === "darwin"
    ? path.join(process.resourcesPath, "native", "darwin", "cpv-atomic-swap")
    : null;
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimePath && fs.existsSync(updaterRuntimePath) ? updaterRuntimePath : null,
    atomicSwapExecutable: atomicSwapPath && fs.existsSync(atomicSwapPath) ? atomicSwapPath : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("voice:update-state", state),
    logger,
  });
  const projectRoot = path.join(__dirname, "..");
  const voiceManifestPath = app.isPackaged
    ? path.join(process.resourcesPath, "voices", "manifest.json")
    : path.join(projectRoot, "voices", "manifest.json");
  const localVoiceManifestPath = path.join(userDataDirectory, "voices", "manifest.json");
  voiceCatalog = new VoiceCatalog({
    manifestPath: voiceManifestPath,
    additionalManifestPaths: [localVoiceManifestPath],
  });
  const current = stateStore.read().settings;
  let selectedVoice = null;
  if (current.selectedVoiceId !== null) {
    try { selectedVoice = voiceCatalog.resolve(current.selectedVoiceId); }
    catch {
      logger.info("voice.selection_removed", { voiceId: current.selectedVoiceId });
    }
  }
  selectedVoice ??= voiceCatalog.defaultVoice();
  if (
    current.selectedVoiceId !== selectedVoice.id ||
    current.selectedVoiceName !== selectedVoice.name
  ) {
    stateStore.replaceSettings({
      ...current,
      selectedVoiceId: selectedVoice.id,
      selectedVoiceName: selectedVoice.name,
    });
  }
  const engineStorage = resolveEngineStoragePaths({
    packaged: app.isPackaged,
    platform: process.platform,
    environment: process.env,
    projectRoot,
    userDataDirectory,
    userDataOverridden: Boolean(configuredUserData),
    productDirectory: PRODUCT_NAME,
  });
  const engineRuntimeRoot = engineStorage.runtimeRoot;
  voiceEngine = new SeedVcEngine({
    paths: resolveSeedVcPaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot,
      runtimeRoot: engineRuntimeRoot,
    }),
    voiceCatalog,
    logger,
    onDiagnostics: scheduleDiagnosticsBroadcast,
  });
  engineInstaller = new EngineInstaller({
    paths: resolveEngineInstallerPaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot,
      runtimeRoot: engineRuntimeRoot,
      pythonRoot: engineStorage.pythonRoot,
      cacheRoot: engineStorage.cacheRoot,
      tempRoot: engineStorage.tempRoot,
    }),
    logger,
    publish: () => {
      void broadcastSnapshot().catch((error) => {
        logger.warn("engine.installation_broadcast_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
  historyStore = createHistoryStore(path.join(userDataDirectory, "history"), {
    onRecovery: (event) => logger.warn("history.index_recovered", event),
  });
  const captureHelperPath = resolveNativeHelperPath("capture", {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const outputHelperPath = resolveNativeHelperPath("output", {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const routeHelperPath = process.platform === "win32"
    ? resolveNativeHelperPath("route", {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      })
    : null;
  capabilities = probePlatformCapabilities({
    helperPaths: { capture: captureHelperPath, output: outputHelperPath, route: routeHelperPath },
  });
  let processRoute = null;
  let audioOutput = null;
  if (process.platform === "darwin") {
    processRoute = new MacProcessRoute({ helperPath: captureHelperPath, logger });
    audioOutput = new MacAudioOutput({ helperPath: outputHelperPath, logger });
  } else if (process.platform === "linux") {
    processRoute = new LinuxProcessRoute({ helperPath: captureHelperPath, logger });
    audioOutput = new LinuxAudioOutput({ helperPath: outputHelperPath, logger });
  } else if (process.platform === "win32") {
    windowsIntegration = createWindowsIntegration({
      captureHelperPath,
      outputHelperPath,
      routeHelperPath,
      logger,
      lifecycleOptions: {
        manualRouteConfigured: stateStore.read().settings.windowsManualRouteConfigured,
        onManualRouteConfigured: () => {
          if (!stateStore.read().settings.windowsManualRouteConfigured) {
            stateStore.setSetting("windowsManualRouteConfigured", true);
          }
        },
      },
    });
    processRoute = windowsIntegration.processRoute;
    audioOutput = windowsIntegration.audioOutput;
  }
  platformAudioSetup = new PlatformAudioSetupController({
    platform: process.platform,
    linuxPolicy: process.platform === "linux" ? linuxAudioPolicy : null,
    linuxProcessRoute: process.platform === "linux" ? processRoute : null,
    windowsIntegration,
    logger,
    publish: () => {
      if (!runtime) return;
      void broadcastSnapshot().catch((error) => {
        logger.warn("platform_audio_setup.broadcast_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
  const adapters = createRuntimeAdapters(capabilities, () => stateStore.read().settings, {
    processRoute,
    audioOutput,
    recordingBusDeviceUid: process.platform === "darwin" ? OBS_RECORDING_DEVICE_UID : null,
    voiceEngine,
    getPlatformAudioSetup: () => platformAudioSetup.getState(),
  });
  historyRecorder = new ConvertedHistoryRecorder({
    historyStore,
    getSettings: () => stateStore.read().settings,
    onEntry: () => { void broadcastSnapshot(); },
    onError: (error) => logger.error("history.record_failed", { message: error.message }),
  });
  runtime = new PipelineRuntime({
    ...adapters,
    onOutputFrame: (outputFrame, sourceFrame) => historyRecorder.accept(outputFrame, sourceFrame),
  });
  stoppedMutationGate = new StoppedMutationGate(() => runtime.snapshot().state);
  runtime.on("changed", (value) => {
    refreshTray();
    if (value.state === "stopped") relayPower.stop();
    if (value.state === "stopped" &&
        windowsIntegration?.routeLifecycle.snapshot().errorCode === "source_process_exited") {
      scheduleWindowsStandbyRecovery();
    }
    send("voice:runtime-changed", value);
    if (value.state !== lastRuntimeState) {
      const event = value.state === "faulted" ? "runtime.faulted" : "runtime.state_changed";
      const data = {
        previousState: lastRuntimeState,
        state: value.state,
        queuedAudioMs: value.queuedAudioMs,
        suppressionHeld: value.suppressionHeld,
        suppressionUncertain: value.suppressionUncertain,
        error: value.error,
      };
      if (value.state === "faulted") logger.error(event, data);
      else logger.info(event, data);
      lastRuntimeState = value.state;
    }
    if (value.state === "armed" || value.state === "faulted") historyRecorder.flush();
  });
  await platformAudioSetup.inspect(stateStore.read().settings);
  if (windowsIntegration && stateStore.read().settings.windowsManualRouteConfigured) {
    scheduleWindowsStandbyRecovery();
  }
  await refreshReadiness({ broadcast: false });

  const persisted = stateStore.read().settings;
  const autostart = getAutostart(app);
  if (app.isPackaged && autostart.supported && autostart.enabled !== persisted.launchAtLogin) {
    setAutostart(app, persisted.launchAtLogin);
  }

  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboarding.complete;
  mainWindow = createWindow({ startHidden });
  registerIpc();
  const trayAvailable = createTray();
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", showMainWindow);
  startCleanupTimer();
  if (isDev) await mainWindow.loadURL(devServerUrl);
  else await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  void updateController.checkOnce();
  logger.info("launcher.started", { platform: process.platform, version: app.getVersion() });

  app.on("activate", showMainWindow);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    appendBoundedLine(
      path.join(userDataDirectory, "launcher-fatal.log"),
      `${new Date().toISOString()} ${error?.stack || error}\n`,
      { maxBytes: 512 * 1024, maxArchives: 1 },
    );
  }
  catch {}
  try { dialog.showErrorBox(`${PRODUCT_NAME} could not start`, message); } catch {}
  app.exit(1);
});
