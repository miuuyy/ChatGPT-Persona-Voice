"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscription(channel, listener) {
  if (typeof listener !== "function") throw new Error("Subscription listener must be a function");
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexPersonaVoice", {
  snapshot: () => ipcRenderer.invoke("voice:snapshot"),
  openSocial: (target) => ipcRenderer.invoke("voice:open-social", target),
  completeOnboarding: () => ipcRenderer.invoke("voice:complete-onboarding"),
  refreshReadiness: () => ipcRenderer.invoke("voice:refresh-readiness"),
  refreshPlatformAudioSetup: () => ipcRenderer.invoke("voice:platform-audio-setup-refresh"),
  openWindowsAudioSetupDownload: () => ipcRenderer.invoke("voice:platform-audio-setup-open-download"),
  installPlatformAudioSetup: () => ipcRenderer.invoke("voice:platform-audio-setup-install"),
  activatePlatformAudioSetup: () => ipcRenderer.invoke("voice:platform-audio-setup-activate"),
  removePlatformAudioSetup: () => ipcRenderer.invoke("voice:platform-audio-setup-remove"),
  installEngine: () => ipcRenderer.invoke("voice:engine-install"),
  cancelEngineInstall: () => ipcRenderer.invoke("voice:engine-install-cancel"),
  removeEngine: () => ipcRenderer.invoke("voice:engine-remove"),
  setSetting: (key, value) => ipcRenderer.invoke("voice:set-setting", key, value),
  setAutostart: (enabled) => ipcRenderer.invoke("voice:set-autostart", enabled),
  selectSource: (source) => ipcRenderer.invoke("voice:select-source", source),
  selectSourceMode: (mode) => ipcRenderer.invoke("voice:select-source-mode", mode),
  selectVoice: (id) => ipcRenderer.invoke("voice:select-voice", id),
  voiceSample: (id) => ipcRenderer.invoke("voice:voice-sample", id),
  openVoiceTerms: (id) => ipcRenderer.invoke("voice:open-voice-terms", id),
  listSources: () => ipcRenderer.invoke("voice:list-sources"),
  start: () => ipcRenderer.invoke("voice:start"),
  stop: () => ipcRenderer.invoke("voice:stop"),
  historyAudio: (id) => ipcRenderer.invoke("voice:history-audio", id),
  clearHistory: () => ipcRenderer.invoke("voice:history-clear"),
  openDataDirectory: () => ipcRenderer.invoke("voice:open-data-directory"),
  openRepository: () => ipcRenderer.invoke("voice:open-repository"),
  installUpdate: () => ipcRenderer.invoke("voice:update-install"),
  windowState: () => ipcRenderer.invoke("voice:window-state"),
  windowControl: (action) => ipcRenderer.send("voice:window-control", action),
  onSnapshot: (listener) => subscription("voice:snapshot-changed", listener),
  onRuntime: (listener) => subscription("voice:runtime-changed", listener),
  onUpdateState: (listener) => subscription("voice:update-state", listener),
  onWindowState: (listener) => subscription("voice:window-state-changed", listener),
});
