"use strict";

// Built renderer + production IPC/state/model selection. Only the GPU engines and
// downloads are fixtures; no network, microphone, app capture, or user data is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This two-model UI check requires Apple Silicon macOS");
}
const root = path.resolve(__dirname, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-model-ui-"));
process.env.CODEX_PERSONA_VOICE_DATA_DIR = dataRoot;
const output = path.join(root, "artifacts", "model-ui");
fs.mkdirSync(output, { recursive: true });
const installers = {};
const report = { scope: "Built renderer and real IPC; fixture downloads and inference", checks: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;

function replaceExport(moduleName, exportName, replacement) {
  const modulePath = require.resolve(path.join(root, "electron", moduleName));
  require(modulePath);
  require.cache[modulePath].exports[exportName] = replacement;
}
for (const [id, installerModule, installerName, engineModule, engineName] of [
  ["seed-vc", "engine-installer.cjs", "EngineInstaller", "seed-vc-engine.cjs", "SeedVcEngine"],
  ["chatterbox", "chatterbox-installer.cjs", "ChatterboxInstaller", "chatterbox-engine.cjs", "ChatterboxEngine"],
]) {
  const Engine = require(path.join(root, "electron", engineModule))[engineName];
  replaceExport(engineModule, engineName, class extends Engine {
    async probe() { return { ready: installers[id]?.state.status === "ready", code: "ui_fixture", detail: "UI fixture engine" }; }
    async prepare() { throw new Error("UI fixtures must never capture or convert audio"); }
  });
  replaceExport(installerModule, installerName, class {
    constructor({ publish }) {
      this.publish = publish;
      this.state = { status: "idle", detail: "UI fixture: model download required", estimatedInstalledBytes: 4 * 1024 ** 3, minimumFreeBytes: 8 * 1024 ** 3 };
      installers[id] = this;
    }
    getState() { return this.state; }
    transition(patch) { this.state = { ...this.state, ...patch }; this.publish(); }
    async install() {
      this.transition({ status: "installing", progress: 0.25, cancellable: true, detail: "UI fixture: downloading" });
      try {
        await new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject; });
        this.transition({ status: "ready", detail: "UI fixture: verified", installedBytes: 2 * 1024 ** 3 });
        return this.state;
      } catch (error) {
        this.transition({ status: /cancelled/.test(error.message) ? "idle" : "error", detail: error.message, resumable: true });
        throw error;
      }
    }
    async cancel() { this.reject(new Error("Engine installation was cancelled")); return true; }
    async remove() { this.transition({ status: "idle", detail: "UI fixture: removed" }); return this.state; }
    async shutdown() {}
  });
}
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    const snapshot = () => evaluate("window.codexPersonaVoice.snapshot()");
    const waitFor = async (code) => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(code)) return;
        await delay(25);
      }
      throw new Error("UI condition timed out: " + code);
    };
    const click = async (selector) => {
      await waitFor("Boolean(document.querySelector(" + JSON.stringify(selector) + "))");
      await waitFor("!document.querySelector(" + JSON.stringify(selector) + ").disabled");
      await evaluate("document.querySelector(" + JSON.stringify(selector) + ").click()");
      await delay(100);
    };
    const select = async (id) => {
      await click('input[name="voice-model"][value="' + id + '"]');
      await waitFor("document.querySelector('input[name=voice-model]:checked')?.value === " + JSON.stringify(id));
      assert.equal((await snapshot()).settings.selectedModelId, id);
    };
    const record = (name) => report.checks.push(name);
    const capture = async (name) => fs.writeFileSync(path.join(output, name + ".png"), (await window.webContents.capturePage()).toPNG());
    try {
      await waitFor("Boolean(document.querySelector('.language-option'))");
      assert.equal((await snapshot()).settings.selectedModelId, "chatterbox");
      const denied = await evaluate("window.codexPersonaVoice.completeOnboarding().then(() => null, e => e.message)");
      assert.match(denied, /Install Chatterbox/);
      assert.equal((await snapshot()).onboarding.complete, false);
      await click('.language-option[lang="en"]');
      await click(".onboarding-footer .button-primary");
      assert.equal(await evaluate("document.querySelectorAll('.model-option').length"), 2);
      assert.equal(await evaluate("document.querySelectorAll('.onboarding-footer .button-secondary').length"), 0);
      assert.match(await evaluate("document.querySelector('.model-options').textContent"), /2024[\s\S]*2025/);
      await capture("onboarding");
      record("Fresh install recommends Chatterbox; setup cannot be skipped with no model");

      await evaluate("document.querySelector('input[value=chatterbox]').focus()");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
      await waitFor("document.querySelector('input[name=voice-model]:checked')?.value === 'seed-vc'");
      assert.equal((await snapshot()).settings.selectedModelId, "seed-vc");
      record("Cards retain native keyboard selection without a visible radio circle");
      await select("chatterbox");
      await click(".onboarding-footer .button-primary");
      await waitFor("Boolean(document.querySelector('[role=progressbar]'))");
      const racing = await evaluate("window.codexPersonaVoice.selectModel('seed-vc').then(() => null, e => e.message)");
      assert.match(racing, /installation/);
      assert.equal(await evaluate("document.querySelector('.model-selector').disabled"), true);
      installers.chatterbox.reject(new Error("UI fixture: download interrupted"));
      await waitFor("Boolean(document.querySelector('[role=alert]'))");
      await click(".onboarding-footer .button-primary");
      await waitFor("Boolean(document.querySelector('[role=progressbar]'))");
      await click(".onboarding-footer .button-secondary");
      await waitFor("!document.querySelector('[role=progressbar]') && !document.querySelector('.model-selector').disabled");
      assert.equal((await snapshot()).onboarding.complete, false);
      record("Download failure, retry, cancellation and racing model selection use production IPC");

      await select("seed-vc");
      await click(".onboarding-footer .button-primary");
      await waitFor("Boolean(document.querySelector('[role=progressbar]'))");
      installers["seed-vc"].finish();
      await waitFor("document.querySelector('.onboarding-engine')?.classList.contains('is-ready')");
      await click(".onboarding-footer .button-primary");
      await waitFor("Boolean(document.querySelector('.app-root'))");
      assert.equal((await snapshot()).onboarding.complete, true);
      assert.equal(installers.chatterbox.state.status, "idle");
      assert.equal(await evaluate("document.querySelector('.model-selector')"), null);
      record("One installed Seed-VC model completes setup; Home has no selector");

      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Settings').click()");
      await waitFor("Boolean(document.querySelector('.settings-navigation'))");
      await evaluate("[...document.querySelectorAll('.settings-navigation button')].find(b => /Voice/.test(b.textContent)).click()");
      await waitFor("Boolean(document.querySelector('.model-selector'))");
      const voiceBefore = (await snapshot()).settings.selectedVoiceId;
      await select("chatterbox");
      await click(".engine-package button:not(:disabled)");
      await waitFor("Boolean(document.querySelector('[role=progressbar]'))");
      installers.chatterbox.finish();
      await waitFor("document.querySelector('.engine-package')?.classList.contains('is-ready')");
      assert.equal((await snapshot()).settings.selectedVoiceId, voiceBefore);
      assert.equal((await snapshot()).models.filter(model => model.installation.status === "ready").length, 2);
      await capture("settings");
      record("Second model installs from settings and preserves the selected voice");

      // Exercise the other one-model completion path through the same real IPC.
      installers["seed-vc"].transition({ status: "idle" });
      assert.equal((await evaluate("window.codexPersonaVoice.completeOnboarding()")).complete, true);
      record("Chatterbox alone also passes the backend setup gate");
      for (const locale of ["ja", "zh-CN", "en"]) {
        await evaluate("window.codexPersonaVoice.setSetting('uiLocale', " + JSON.stringify(locale) + ")");
        await waitFor("document.documentElement.lang === " + JSON.stringify(locale));
        window.setSize(920, 720);
        await delay(100);
        assert.equal(await evaluate("[...document.querySelectorAll('.model-option')].every(e => e.scrollWidth <= e.clientWidth + 1)"), true);
        await capture("settings-" + locale);
      }
      record("All three locales fit the model cards at the minimum window size");
      report.ok = true;
    } catch (error) {
      failed = true; report.ok = false; report.error = error.stack; console.error(error);
      await capture("failure");
    } finally {
      fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report));
      for (const installer of Object.values(installers)) installer.reject?.(new Error("UI test finished"));
      app.quit();
    }
  });
});
app.on("will-quit", () => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  if (failed) app.exit(1);
});
require(path.join(root, "electron", "main.cjs"));
