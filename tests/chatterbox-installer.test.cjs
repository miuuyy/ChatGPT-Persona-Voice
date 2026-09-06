"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ChatterboxInstaller } = require("../electron/chatterbox-installer.cjs");
const { resolveChatterboxPaths, inspectChatterboxRuntime } = require("../electron/chatterbox-runtime.cjs");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv D installer "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveChatterboxPaths({ projectRoot: root, runtimeRoot: path.join(root, "runtime/chatterbox") });
  fs.mkdirSync(paths.engineRoot, { recursive: true });
  for (const file of [paths.requirementsPath, paths.workerPath, paths.installerPath]) fs.writeFileSync(file, "test fixture");
  fs.writeFileSync(paths.modelLockPath, JSON.stringify({ profile: "darwin-arm64-mlx", model: { files: { "s3gen.safetensors": "a".repeat(64) } } }));
  const uvPath = path.join(root, "uv");
  fs.writeFileSync(uvPath, "fixture");
  const commands = [];
  const installer = new ChatterboxInstaller({ paths, uvPath, platform: "darwin", arch: "arm64",
    freeBytes: () => 64 * 1024 ** 3,
    execute: async (command) => {
      commands.push(command);
      if (command.args[0] === "--version") command.onOutput("uv 0.11.14");
      if (command.args[0] === "venv") {
        const staged = resolveChatterboxPaths({ projectRoot: root, runtimeRoot: installer.stagingRoot });
        fs.mkdirSync(path.dirname(staged.pythonPath), { recursive: true });
        fs.writeFileSync(staged.pythonPath, "test python");
      }
      if (command.executable.endsWith("/python")) {
        const staged = resolveChatterboxPaths({ projectRoot: root, runtimeRoot: installer.stagingRoot });
        fs.mkdirSync(staged.weightsPath, { recursive: true });
        fs.writeFileSync(path.join(staged.weightsPath, "s3gen.safetensors"), "mock verified model");
        fs.writeFileSync(staged.installManifestPath, JSON.stringify({ schemaVersion: 1, profile: "darwin-arm64-mlx",
          modelLockSha256: hash(paths.modelLockPath), requirementsSha256: hash(paths.requirementsPath),
          modelSha256: "a".repeat(64), modelBytes: Buffer.byteLength("mock verified model") }));
      }
    }, ...overrides });
  return { installer, paths, commands, root };
}

test("Chatterbox installs to its own relocatable runtime and removes only its own files", async (t) => {
  const { installer, paths, root, commands } = fixture(t);
  const seedPython = path.join(root, "runtime/python/keep");
  fs.mkdirSync(path.dirname(seedPython), { recursive: true });
  fs.writeFileSync(seedPython, "existing Tiny Python");
  const state = await installer.install();
  assert.equal(state.status, "ready");
  assert.equal(inspectChatterboxRuntime(paths, "darwin", "arm64").ready, true);
  assert.ok(commands[1].args.includes("--relocatable"));
  assert.ok(commands[2].args.includes("--strict"));
  assert.equal(commands.at(-1).args[0], "-I");
  assert.notEqual(commands[1].environment.UV_PYTHON_INSTALL_DIR, path.dirname(seedPython));
  const count = commands.length;
  await installer.install();
  assert.equal(commands.length, count);
  await installer.remove();
  assert.equal(fs.existsSync(paths.runtimeRoot), false);
  assert.equal(fs.readFileSync(seedPython, "utf8"), "existing Tiny Python");
});

test("a different installer version cannot create a ready runtime", async (t) => {
  const { installer, paths } = fixture(t, { execute: async (command) => command.onOutput("uv 0.12.0") });
  await assert.rejects(installer.install(), /requires uv 0.11.14/);
  assert.equal(installer.getState().status, "error");
  assert.equal(fs.existsSync(paths.runtimeRoot), false);
});

test("corrupt installed model metadata is blocked and offers explicit removal before reinstall", async (t) => {
  const { installer, paths } = fixture(t);
  await installer.install();
  fs.appendFileSync(path.join(paths.weightsPath, "s3gen.safetensors"), "corrupt");
  assert.equal(inspectChatterboxRuntime(paths, "darwin", "arm64").ready, false);
  assert.equal(installer.initialState().status, "error");
  fs.writeFileSync(paths.requirementsPath, "changed package lock");
  assert.equal(inspectChatterboxRuntime(paths, "darwin", "arm64").ready, false);
});

test("cancellation terminates the active operation without publishing a runtime", async (t) => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { installer, paths } = fixture(t, { execute: async ({ signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      const error = new Error("Engine installation was cancelled"); error.code = "engine_install_cancelled"; reject(error);
    }, { once: true }));
  } });
  const install = installer.install();
  const rejected = assert.rejects(install, /cancelled/);
  await running;
  assert.equal(await installer.cancel(), true);
  await rejected;
  assert.equal(installer.getState().status, "idle");
  assert.equal(fs.existsSync(paths.runtimeRoot), false);
});
