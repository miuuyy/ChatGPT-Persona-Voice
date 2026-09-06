"use strict";

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { requireVoiceModel } = require("./voice-models.cjs");

const STATE_VERSION = 1;
const SOURCE_MODES = new Set(["codex-app-server", "desktop-application"]);
const RETENTION_OPTIONS = new Set([1, 6, 24, 72, 168, null]);
const UI_LOCALES = new Set(["en", "ja", "zh-CN"]);

const DEFAULT_SETTINGS = Object.freeze({
  uiLocale: null,
  sourceMode: "desktop-application",
  sourceId: null,
  sourceName: null,
  selectedModelId: "seed-vc",
  selectedVoiceId: "voicevox-shikoku-metan-normal",
  selectedVoiceName: "Shikoku Metan",
  retentionHours: 6,
  saveConvertedAudio: false,
  recordingBusEnabled: false,
  launchAtLogin: false,
  keepRunningOnClose: false,
  windowsManualRouteConfigured: false,
});
const DEFAULT_ONBOARDING = Object.freeze({
  complete: false,
  githubOpened: false,
  xOpened: false,
});

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const ONBOARDING_KEYS = new Set(Object.keys(DEFAULT_ONBOARDING));

function optionalString(value, field, maxLength = 240) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters or be null`);
  }
  return normalized;
}

function booleanSetting(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.has(key)) throw new Error(`Unknown persisted setting: ${key}`);
  }
  const sourceMode = value.sourceMode ?? DEFAULT_SETTINGS.sourceMode;
  if (!SOURCE_MODES.has(sourceMode)) throw new Error("Unknown audio source mode");
  const selectedModelId = value.selectedModelId === undefined
    ? DEFAULT_SETTINGS.selectedModelId : value.selectedModelId;
  requireVoiceModel(selectedModelId);

  const uiLocale = value.uiLocale === undefined
    ? DEFAULT_SETTINGS.uiLocale
    : value.uiLocale;
  if (uiLocale !== null && !UI_LOCALES.has(uiLocale)) {
    throw new Error("Interface language must be en, ja, zh-CN, or null");
  }

  const retentionHours = value.retentionHours === undefined
    ? DEFAULT_SETTINGS.retentionHours
    : value.retentionHours;
  if (!RETENTION_OPTIONS.has(retentionHours)) {
    throw new Error("History retention must be 1, 6, 24, 72, 168 hours, or never");
  }

  const sourceId = value.sourceId === undefined
    ? DEFAULT_SETTINGS.sourceId
    : optionalString(value.sourceId, "sourceId", 4096);
  const sourceName = value.sourceName === undefined
    ? DEFAULT_SETTINGS.sourceName
    : optionalString(value.sourceName, "sourceName", 160);
  if ((sourceId === null) !== (sourceName === null)) {
    throw new Error("sourceId and sourceName must be selected together");
  }

  const selectedVoiceId = value.selectedVoiceId === undefined
    ? DEFAULT_SETTINGS.selectedVoiceId
    : optionalString(value.selectedVoiceId, "selectedVoiceId", 240);
  const selectedVoiceName = value.selectedVoiceName === undefined
    ? DEFAULT_SETTINGS.selectedVoiceName
    : optionalString(value.selectedVoiceName, "selectedVoiceName", 160);
  if ((selectedVoiceId === null) !== (selectedVoiceName === null)) {
    throw new Error("selectedVoiceId and selectedVoiceName must be selected together");
  }

  return {
    uiLocale,
    sourceMode,
    sourceId,
    sourceName,
    selectedModelId,
    selectedVoiceId,
    selectedVoiceName,
    retentionHours,
    saveConvertedAudio: booleanSetting(value.saveConvertedAudio, "saveConvertedAudio", DEFAULT_SETTINGS.saveConvertedAudio),
    recordingBusEnabled: booleanSetting(
      value.recordingBusEnabled,
      "recordingBusEnabled",
      DEFAULT_SETTINGS.recordingBusEnabled,
    ),
    launchAtLogin: booleanSetting(value.launchAtLogin, "launchAtLogin", DEFAULT_SETTINGS.launchAtLogin),
    keepRunningOnClose: booleanSetting(value.keepRunningOnClose, "keepRunningOnClose", DEFAULT_SETTINGS.keepRunningOnClose),
    windowsManualRouteConfigured: booleanSetting(
      value.windowsManualRouteConfigured,
      "windowsManualRouteConfigured",
      DEFAULT_SETTINGS.windowsManualRouteConfigured,
    ),
  };
}

function normalizeOnboarding(value = DEFAULT_ONBOARDING) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Onboarding state must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!ONBOARDING_KEYS.has(key)) throw new Error(`Unknown onboarding field: ${key}`);
  }
  const result = {};
  for (const key of ONBOARDING_KEYS) {
    const current = value[key] ?? DEFAULT_ONBOARDING[key];
    if (typeof current !== "boolean") throw new Error(`${key} must be a boolean`);
    result[key] = current;
  }
  return result;
}

function defaultState(initialModelId = DEFAULT_SETTINGS.selectedModelId) {
  requireVoiceModel(initialModelId);
  return {
    version: STATE_VERSION,
    settings: { ...DEFAULT_SETTINGS, selectedModelId: initialModelId },
    onboarding: { ...DEFAULT_ONBOARDING },
  };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher state must be an object");
  }
  if (value.version !== STATE_VERSION) {
    throw new Error(`Unsupported launcher state version: ${String(value.version)}`);
  }
  return {
    version: STATE_VERSION,
    settings: normalizeSettings(value.settings),
    onboarding: normalizeOnboarding(value.onboarding),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStateStore(filePath, { initialModelId = DEFAULT_SETTINGS.selectedModelId } = {}) {
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    state = defaultState(initialModelId);
    writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function persist(next) {
    const normalized = normalizeState(next);
    writePrivateFileAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    state = normalized;
    return clone(state);
  }

  return {
    filePath,
    read: () => clone(state),
    replaceSettings: (settings) => persist({
      ...state,
      version: STATE_VERSION,
      settings: normalizeSettings(settings),
    }),
    setSetting: (key, value) => {
      if (!SETTING_KEYS.has(key)) throw new Error(`Unknown setting: ${String(key)}`);
      return persist({
        ...state,
        version: STATE_VERSION,
        settings: normalizeSettings({ ...state.settings, [key]: value }),
      });
    },
    setOnboarding: (patch) => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("Onboarding update must be an object");
      }
      return persist({
        ...state,
        version: STATE_VERSION,
        onboarding: normalizeOnboarding({ ...state.onboarding, ...patch }),
      });
    },
  };
}

module.exports = {
  DEFAULT_ONBOARDING,
  DEFAULT_SETTINGS,
  ONBOARDING_KEYS,
  RETENTION_OPTIONS,
  SETTING_KEYS,
  SOURCE_MODES,
  UI_LOCALES,
  STATE_VERSION,
  createStateStore,
  defaultState,
  normalizeSettings,
  normalizeOnboarding,
  normalizeState,
};
