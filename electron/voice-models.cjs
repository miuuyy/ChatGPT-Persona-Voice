"use strict";

const MODELS = Object.freeze([
  Object.freeze({ id: "seed-vc", name: "Seed-VC Tiny", releaseYear: 2024, blockMs: 300,
    startupPrebufferMs: 500, startupDelayMs: 0 }),
  Object.freeze({ id: "chatterbox", name: "Chatterbox", releaseYear: 2025, blockMs: 640,
    startupPrebufferMs: 400, startupDelayMs: 200 }),
]);

function requireVoiceModel(id) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown voice model: ${String(id)}`);
  return model;
}

function voiceModels(platform = process.platform, arch = process.arch) {
  return MODELS.map((model) => ({
    ...model,
    recommended: model.id === "chatterbox" && platform === "darwin" && arch === "arm64",
    supported: model.id === "chatterbox"
      ? platform === "darwin" && arch === "arm64"
      : (platform === "darwin" && arch === "arm64") || (["win32", "linux"].includes(platform) && arch === "x64"),
  }));
}

function initialVoiceModel(platform = process.platform, arch = process.arch) {
  return platform === "darwin" && arch === "arm64" ? "chatterbox" : "seed-vc";
}

// One explicit user choice owns each session. This is a fixed built-in catalog,
// not a fallback chain: any failure in the selected engine reaches the relay.
class VoiceModelSelection {
  constructor({ engines, installers, getSettings, platform = process.platform, arch = process.arch }) {
    this.engines = engines;
    this.installers = installers;
    this.getSettings = getSettings;
    this.models = voiceModels(platform, arch);
  }
  selected(settings = this.getSettings()) {
    return requireVoiceModel(settings.selectedModelId);
  }
  engine(settings = this.getSettings()) { return this.engines[this.selected(settings).id]; }
  installer() { return this.installers[this.selected().id]; }
  list() { return this.models.map((model) => ({ ...model, installation: this.installers[model.id].getState() })); }
  probe(settings) { return this.engine(settings).probe(settings); }
  prepare(settings, format, options) { return this.engine(settings).prepare(settings, format, options); }
  diagnostics() { return this.engine().diagnostics(); }
  async assertInstalled() {
    const settings = this.getSettings();
    const model = this.models.find((entry) => entry.id === this.selected(settings).id);
    if (!model.supported || this.installers[model.id].getState().status !== "ready") {
      throw new Error(`Install ${model.name} before completing setup`);
    }
    // Recheck the files, so a stale installation snapshot cannot finish setup.
    const readiness = await this.probe(settings);
    if (!readiness.ready) throw new Error(readiness.detail);
  }
  async select(id, persist) {
    const model = requireVoiceModel(id);
    if (!this.models.find((entry) => entry.id === id).supported) {
      throw new Error(`${model.name} is not supported on this platform`);
    }
    if (id === this.selected().id) return;
    await this.engine().shutdown();
    persist(id);
  }
  async shutdown() {
    const results = await Promise.allSettled(Object.values(this.engines).map((engine) => engine.shutdown()));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Voice engine shutdown failed");
  }
}

module.exports = { requireVoiceModel, voiceModels, initialVoiceModel, VoiceModelSelection };
