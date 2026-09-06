"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { executeCommand, throwIfCancelled, UV_VERSION } = require("./engine-installer.cjs");
const { resolveChatterboxPaths, inspectChatterboxRuntime } = require("./chatterbox-runtime.cjs");

function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? directorySize(target) : entry.isFile() ? fs.statSync(target).size : 0);
  }, 0);
}

class ChatterboxInstaller {
  constructor({ paths, uvPath, platform = process.platform, arch = process.arch,
    execute = executeCommand, publish = () => {}, logger = null, checkpointPath = null,
    freeBytes = (directory) => { const stats = fs.statfsSync(directory); return Number(stats.bavail) * Number(stats.bsize); } }) {
    this.paths = paths;
    this.uvPath = uvPath;
    this.platform = platform;
    this.arch = arch;
    this.execute = execute;
    this.freeBytes = freeBytes;
    this.publish = publish;
    this.logger = logger;
    this.checkpointPath = checkpointPath;
    this.stagingRoot = `${paths.runtimeRoot}.installing`;
    this.pythonRoot = `${paths.runtimeRoot}-python`;
    this.tempRoot = `${paths.runtimeRoot}-temp`;
    this.operation = null;
    this.controller = null;
    this.state = this.initialState();
  }
  supported() { return this.platform === "darwin" && this.arch === "arm64"; }
  initialState() {
    const installed = inspectChatterboxRuntime(this.paths, this.platform, this.arch);
    return {
      status: !this.supported() ? "unavailable" : installed.ready ? "ready"
        : fs.existsSync(this.paths.runtimeRoot) ? "error" : "idle",
      detail: installed.detail,
      ...(installed.ready ? { installedBytes: directorySize(this.paths.runtimeRoot) + directorySize(this.pythonRoot) }
        : { resumable: fs.existsSync(this.stagingRoot) }),
      estimatedInstalledBytes: 4 * 1024 ** 3, minimumFreeBytes: 8 * 1024 ** 3,
    };
  }
  getState() { return this.state; }
  transition(next) {
    this.state = { estimatedInstalledBytes: 4 * 1024 ** 3, minimumFreeBytes: 8 * 1024 ** 3, ...next };
    this.publish(this.state);
    return this.state;
  }
  phase(phase, progress, detail) {
    this.transition({ status: "installing", phase, progress, detail, cancellable: phase !== "publishing" });
  }
  environment() {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: this.tempRoot,
      PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1", UV_NO_CONFIG: "1", UV_MANAGED_PYTHON: "1",
      UV_PYTHON_INSTALL_DIR: this.pythonRoot, UV_LINK_MODE: "copy", UV_KEYRING_PROVIDER: "disabled",
      UV_DEFAULT_INDEX: "https://pypi.org/simple", UV_INDEX_STRATEGY: "first-index",
      UV_CACHE_DIR: path.join(this.tempRoot, "uv-cache"),
      PIP_CONFIG_FILE: "/dev/null", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      HF_HOME: path.join(this.tempRoot, "huggingface"),
    };
  }
  async command(executable, args, signal, onOutput = () => {}) {
    throwIfCancelled(signal);
    await this.execute({ executable, args, cwd: this.paths.engineRoot, environment: this.environment(), signal,
      onOutput: (line) => { onOutput(line); this.logger?.debug?.("chatterbox.install_output", { message: line }); } });
    throwIfCancelled(signal);
  }
  install() {
    if (this.operation) throw new Error("A Chatterbox package operation is already active");
    if (!this.supported()) throw new Error(this.state.detail);
    if (this.state.status === "ready") return Promise.resolve(this.state);
    this.controller = new AbortController();
    this.operation = this.installPackage(this.controller.signal).finally(() => {
      this.operation = null; this.controller = null;
    });
    return this.operation;
  }
  async installPackage(signal) {
    try {
      if (!this.uvPath || !fs.existsSync(this.uvPath)) throw new Error("The pinned uv engine installer is missing");
      fs.mkdirSync(path.dirname(this.paths.runtimeRoot), { recursive: true, mode: 0o700 });
      if (this.freeBytes(path.dirname(this.paths.runtimeRoot)) < this.state.minimumFreeBytes) {
        throw new Error("Chatterbox installation requires 8 GiB of free disk space");
      }
      // A failed installation cannot overwrite an existing runtime. Removal is a
      // separate explicit operation, and Seed-VC owns different storage paths.
      if (fs.existsSync(this.paths.runtimeRoot)) throw new Error("Remove the incomplete Chatterbox package before reinstalling");
      fs.mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
      this.phase("preparing", 0.03, "Checking the Chatterbox installer");
      let version = "";
      await this.command(this.uvPath, ["--version"], signal, (line) => { version += line; });
      if (!new RegExp(`^uv ${UV_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`).test(version)) {
        throw new Error(`Chatterbox requires uv ${UV_VERSION}`);
      }
      this.phase("python", 0.1, "Installing managed Python 3.11.14 for Chatterbox");
      const staged = resolveChatterboxPaths({ projectRoot: path.resolve(this.paths.engineRoot, "../.."), runtimeRoot: this.stagingRoot });
      await this.command(this.uvPath, ["venv", "--managed-python", "--relocatable", "--allow-existing",
        "--python", "3.11.14", path.join(this.stagingRoot, ".venv")], signal);
      this.phase("packages", 0.25, "Installing pinned Chatterbox packages and source revisions");
      await this.command(this.uvPath, ["pip", "sync", "--strict", "--python", staged.pythonPath,
        this.paths.requirementsPath], signal);
      this.phase("models", 0.65, "Verifying Metal and acquiring the pinned Chatterbox model");
      await this.command(staged.pythonPath, ["-I", "-u", this.paths.installerPath,
        "--runtime-root", this.stagingRoot, ...(this.checkpointPath ? ["--checkpoint", this.checkpointPath] : ["--download"])], signal);
      this.phase("verifying", 0.92, "Checking the verified Chatterbox installation");
      const readiness = inspectChatterboxRuntime({ ...this.paths, ...staged }, this.platform, this.arch);
      if (!readiness.ready) throw new Error(readiness.detail);
      const installedBytes = directorySize(this.stagingRoot) + directorySize(this.pythonRoot);
      if (installedBytes > 15 * 1024 ** 3) throw new Error("Chatterbox exceeds the 15 GiB installed engine limit");
      throwIfCancelled(signal);
      this.phase("publishing", 0.98, "Publishing the verified Chatterbox installation");
      fs.renameSync(this.stagingRoot, this.paths.runtimeRoot);
      const installed = inspectChatterboxRuntime(this.paths, this.platform, this.arch);
      if (!installed.ready) throw new Error(installed.detail);
      fs.rmSync(this.tempRoot, { recursive: true, force: true });
      return this.transition({ status: "ready", detail: installed.detail, installedBytes });
    } catch (error) {
      this.transition({ status: error.code === "engine_install_cancelled" ? "idle" : "error",
        detail: error.message, resumable: fs.existsSync(this.stagingRoot) });
      throw error;
    }
  }
  async cancel() {
    if (!this.operation || !this.controller || this.state.phase === "publishing") return false;
    this.controller.abort();
    await this.operation.catch(() => {});
    return true;
  }
  async remove() {
    if (this.operation) throw new Error("A Chatterbox package operation is already active");
    this.transition({ status: "removing", detail: "Removing Chatterbox" });
    try {
      for (const target of [this.paths.runtimeRoot, this.stagingRoot, this.pythonRoot, this.tempRoot]) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      return this.transition(this.initialState());
    } catch (error) {
      this.transition({ status: "error", detail: error.message, resumable: false });
      throw error;
    }
  }
  async shutdown() { await this.cancel(); }
}

module.exports = { ChatterboxInstaller };
