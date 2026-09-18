"use strict";

const DEFAULT_TARGET_APP = "chatgpt";
const TARGET_APPS = Object.freeze(["chatgpt", "grok-bot"]);

const TARGET_APP_DEFINITIONS = Object.freeze({
  chatgpt: Object.freeze({
    id: "chatgpt",
    label: "ChatGPT",
    processPattern:
      /(?:^|[\\/])(?:chatgpt|openai codex|codex desktop)(?:\.exe)?$/i,
    linuxRouteIds: Object.freeze(["chatgpt", "codex"]),
  }),
  "grok-bot": Object.freeze({
    id: "grok-bot",
    label: "Grok Bot",
    processPattern: /(?:^|[\\/])grok[ _-]?bot(?:\.exe)?$/i,
    linuxRouteIds: Object.freeze(["grok-bot"]),
  }),
});

function requireTargetApp(value) {
  if (!TARGET_APPS.includes(value)) {
    throw new Error(`Unknown target application: ${String(value)}`);
  }
  return value;
}

function targetAppDefinition(value = DEFAULT_TARGET_APP) {
  return TARGET_APP_DEFINITIONS[requireTargetApp(value)];
}

function targetAppLabel(value = DEFAULT_TARGET_APP) {
  return targetAppDefinition(value).label;
}

function targetAppProcessPattern(value = DEFAULT_TARGET_APP) {
  return targetAppDefinition(value).processPattern;
}

function targetAppLinuxRouteIds(value = DEFAULT_TARGET_APP) {
  return [...targetAppDefinition(value).linuxRouteIds];
}

module.exports = {
  DEFAULT_TARGET_APP,
  TARGET_APPS,
  TARGET_APP_DEFINITIONS,
  requireTargetApp,
  targetAppDefinition,
  targetAppLabel,
  targetAppLinuxRouteIds,
  targetAppProcessPattern,
};
