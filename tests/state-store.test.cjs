"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStateStore } = require("../electron/state-store.cjs");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("state store initializes safe defaults and migrates pre-onboarding state", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "state.json");
  const store = createStateStore(filePath);
  assert.equal(store.read().settings.retentionHours, 6);
  assert.equal(store.read().settings.saveConvertedAudio, false);
  assert.equal(store.read().settings.recordingBusEnabled, false);
  assert.equal(store.read().settings.keepRunningOnClose, false);
  assert.equal(store.read().settings.uiLocale, null);
  assert.equal(store.read().settings.sourceMode, "desktop-application");
  assert.equal(store.read().settings.targetApp, "chatgpt");
  assert.equal(store.read().settings.selectedVoiceId, "voicevox-shikoku-metan-normal");
  assert.equal(store.read().settings.selectedVoiceName, "Shikoku Metan");
  assert.deepEqual(store.read().onboarding, {
    complete: false,
    githubOpened: false,
    xOpened: false,
  });
  assert.ok(fs.existsSync(filePath));

  const legacyDirectory = temporaryDirectory(t);
  const legacyFilePath = path.join(legacyDirectory, "state.json");
  fs.writeFileSync(legacyFilePath, JSON.stringify({
    version: 1,
    settings: createStateStore(path.join(legacyDirectory, "defaults.json")).read().settings,
  }));
  assert.deepEqual(createStateStore(legacyFilePath).read().onboarding, {
    complete: false,
    githubOpened: false,
    xOpened: false,
  });
  assert.equal(createStateStore(legacyFilePath).read().settings.uiLocale, null);
});

test("state store validates and atomically persists settings, identity, and onboarding", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "state.json");
  const store = createStateStore(filePath);
  store.setSetting("retentionHours", 24);
  store.setSetting("saveConvertedAudio", false);
  store.setSetting("recordingBusEnabled", true);
  store.setSetting("uiLocale", "ja");
  assert.equal(createStateStore(filePath).read().settings.retentionHours, 24);
  assert.equal(createStateStore(filePath).read().settings.saveConvertedAudio, false);
  assert.equal(createStateStore(filePath).read().settings.recordingBusEnabled, true);
  assert.equal(createStateStore(filePath).read().settings.uiLocale, "ja");
  assert.throws(() => store.setSetting("retentionHours", 12), /History retention/);
  assert.throws(() => store.setSetting("saveConvertedAudio", "yes"), /must be a boolean/);
  assert.throws(() => store.setSetting("recordingBusEnabled", "yes"), /must be a boolean/);
  assert.throws(() => store.setSetting("uiLocale", "fr"), /Interface language/);
  assert.throws(() => store.setSetting("uiLocale", ""), /Interface language/);
  assert.throws(() => store.setSetting("imaginary", true), /Unknown setting/);

  for (const locale of ["en", "ja", "zh-CN"]) {
    store.setSetting("uiLocale", locale);
    assert.equal(createStateStore(filePath).read().settings.uiLocale, locale);
  }
  store.setSetting("uiLocale", null);
  assert.equal(store.read().settings.uiLocale, null);
  store.setSetting("targetApp", "grok-bot");
  assert.equal(createStateStore(filePath).read().settings.targetApp, "grok-bot");
  assert.throws(() => store.setSetting("targetApp", "other"), /Unknown target application/);

  assert.throws(() => store.setSetting("sourceId", "process:darwin:test"), /selected together/);
  const current = store.read().settings;
  store.replaceSettings({ ...current, sourceId: "process:darwin:test", sourceName: "ChatGPT" });
  assert.equal(store.read().settings.sourceName, "ChatGPT");

  store.setOnboarding({ githubOpened: true });
  store.setSetting("retentionHours", 24);
  store.setOnboarding({ xOpened: true, complete: true });
  assert.deepEqual(createStateStore(filePath).read().onboarding, {
    complete: true,
    githubOpened: true,
    xOpened: true,
  });
  assert.throws(() => store.setOnboarding({ githubOpened: "yes" }), /must be a boolean/);
  assert.throws(() => store.setOnboarding({ imaginary: true }), /Unknown onboarding field/);
});

test("corrupt persisted state fails explicitly", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "state.json");
  fs.writeFileSync(filePath, "{ definitely not json");
  assert.throws(() => createStateStore(filePath), /Unexpected token|JSON/);
});
