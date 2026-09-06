"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VoiceModelSelection, initialVoiceModel } = require("../electron/voice-models.cjs");
const { createStateStore } = require("../electron/state-store.cjs");
const { StoppedMutationGate } = require("../electron/stopped-mutation-gate.cjs");
const { resolveChatterboxPaths } = require("../electron/chatterbox-runtime.cjs");

function fixture(t, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-model-choice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  const store = createStateStore(file);
  const calls = [];
  const engines = Object.fromEntries(["seed-vc", "chatterbox"].map((id) => [id, {
    probe: async () => ({ ready: id === "seed-vc", code: id }),
    prepare: async () => { calls.push(`prepare:${id}`); throw new Error(`${id} failed`); },
    shutdown: async () => { calls.push(`shutdown:${id}`); },
    diagnostics: () => ({ id }),
  }]));
  const installation = { "seed-vc": { status: "ready" }, chatterbox: { status: "idle" } };
  const installers = Object.fromEntries(Object.keys(installation).map((id) => [id, {
    getState: () => installation[id],
  }]));
  const selection = new VoiceModelSelection({ engines, installers, platform, arch: platform === "darwin" ? "arm64" : "x64",
    getSettings: () => store.read().settings });
  return { store, file, engines, calls, installation, selection, persist: (id) => store.setSetting("selectedModelId", id) };
}

test("explicit model selection closes the previous engine and persists without changing the voice or source", async (t) => {
  const { selection, calls, store, file, persist } = fixture(t);
  const previous = store.read().settings;
  await selection.select("chatterbox", persist);
  assert.equal(selection.selected().blockMs, require("../engine/chatterbox/model-lock.json").stream.blockMs);
  assert.deepEqual(calls, ["shutdown:seed-vc"]);
  assert.deepEqual(createStateStore(file).read().settings, { ...previous, selectedModelId: "chatterbox" });
  assert.equal((await selection.probe(store.read().settings)).ready, false);
  await assert.rejects(selection.prepare(store.read().settings, {}), /chatterbox failed/);
  assert.deepEqual(calls, ["shutdown:seed-vc", "prepare:chatterbox"]);
  await selection.select("seed-vc", persist);
  assert.equal(calls.at(-1), "shutdown:chatterbox");
});

test("invalid and unsupported selections fail before changing settings or closing a worker", async (t) => {
  const { selection, calls, store, persist } = fixture(t, "linux");
  await assert.rejects(selection.select("unknown", persist), /Unknown voice model/);
  await assert.rejects(selection.select("chatterbox", persist), /not supported/);
  assert.throws(() => store.setSetting("selectedModelId", null), /Unknown voice model/);
  assert.throws(() => store.setSetting("selectedModelId", "auto"), /Unknown voice model/);
  assert.equal(store.read().settings.selectedModelId, "seed-vc");
  assert.deepEqual(calls, []);
});

test("worker close failure preserves selection and the stopped gate excludes racing Start", async (t) => {
  const { selection, engines, store, persist } = fixture(t);
  engines["seed-vc"].shutdown = async () => { throw new Error("still running"); };
  await assert.rejects(selection.select("chatterbox", persist), /still running/);
  assert.equal(store.read().settings.selectedModelId, "seed-vc");
  let finish;
  engines["seed-vc"].shutdown = () => new Promise((resolve) => { finish = resolve; });
  let state = "stopped";
  const gate = new StoppedMutationGate(() => state);
  const switching = gate.run("model selection", () => selection.select("chatterbox", persist));
  assert.throws(() => gate.assertCanStart(), /model selection/);
  finish();
  await switching;
  gate.assertCanStart();
  state = "armed";
  await assert.rejects(gate.run("model selection", () => selection.select("seed-vc", persist)), /Stop the relay/);
  assert.equal(store.read().settings.selectedModelId, "chatterbox");
});

test("existing settings retain the original model; packaged worker assets resolve outside asar", (t) => {
  const { store, file } = fixture(t);
  const state = store.read();
  delete state.settings.selectedModelId;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(createStateStore(file, { initialModelId: "chatterbox" }).read().settings.selectedModelId, "seed-vc");
  const resourcesPath = path.normalize("/Applications/Persona Voice.app/Contents/Resources");
  const runtimeRoot = path.normalize("/private/test/runtime/chatterbox");
  const paths = resolveChatterboxPaths({ isPackaged: true, resourcesPath, runtimeRoot });
  assert.equal(paths.workerPath, path.normalize("/Applications/Persona Voice.app/Contents/Resources/engine/chatterbox/worker.py"));
  assert.equal(paths.pythonPath, path.normalize("/private/test/runtime/chatterbox/.venv/bin/python"));
});

test("fresh Apple Silicon installs recommend Chatterbox without overwriting an existing selection", (t) => {
  const { file } = fixture(t);
  const fresh = path.join(path.dirname(file), "fresh.json");
  const store = createStateStore(fresh, { initialModelId: initialVoiceModel("darwin", "arm64") });
  assert.equal(store.read().settings.selectedModelId, "chatterbox");
  assert.equal(store.read().onboarding.complete, false);
  store.setSetting("selectedModelId", "seed-vc");
  assert.equal(createStateStore(fresh, { initialModelId: "chatterbox" }).read().settings.selectedModelId, "seed-vc");
  for (const platform of ["win32", "linux"]) {
    assert.equal(initialVoiceModel(platform, "x64"), "seed-vc");
  }
  assert.equal(initialVoiceModel("darwin", "x64"), "seed-vc");
});

test("setup needs only the selected model, and cannot complete on idle, cancelled or broken installs", async (t) => {
  const { selection, installation, engines, persist } = fixture(t);
  // Seed is sufficient even with no Chatterbox package.
  await selection.assertInstalled();
  await selection.select("chatterbox", persist);
  for (const status of ["idle", "installing", "error", "removing", "unavailable"]) {
    installation.chatterbox = { status };
    await assert.rejects(selection.assertInstalled(), /Install Chatterbox/);
  }
  installation.chatterbox = { status: "ready" };
  engines.chatterbox.probe = async () => ({ ready: false, detail: "Checkpoint missing" });
  await assert.rejects(selection.assertInstalled(), /Checkpoint missing/);
  engines.chatterbox.probe = async () => ({ ready: true });
  installation["seed-vc"] = { status: "idle" };
  await selection.assertInstalled();
  const models = selection.list();
  assert.deepEqual(models.map((model) => model.installation.status), ["idle", "ready"]);
  assert.deepEqual(models.filter((model) => model.recommended).map((model) => model.id), ["chatterbox"]);
});
