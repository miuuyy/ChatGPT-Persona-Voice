"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { terminateChild, waitForExit } = require("./native-helper.cjs");
const {
  inspectSeedVcRuntime,
  pythonPathForRuntime,
  resolveSeedVcRuntimeProfile,
} = require("./seed-vc-engine.cjs");

const UV_VERSION = "0.11.14";
const MAX_RUNTIME_BYTES = 15 * 1024 ** 3;
const MAX_INSTALL_TRANSACTION_BYTES = 20 * 1024 ** 3;
const MIN_INSTALL_FREE_BYTES = 6 * 1024 ** 3;
const ESTIMATED_INSTALLED_BYTES = 2.5 * 1024 ** 3;
const PHASES = Object.freeze({
  preparing: { progress: 0.04, detail: "Preparing the private engine staging area" },
  python: { progress: 0.12, detail: "Installing managed Python 3.11" },
  packages: { progress: 0.28, detail: "Installing the locked Seed-VC runtime packages" },
  hardware: { progress: 0.52, detail: "Verifying the realtime accelerator" },
  models: { progress: 0.58, detail: "Downloading pinned model files" },
  verifying: { progress: 0.9, detail: "Verifying packages and model SHA-256 hashes" },
  publishing: { progress: 0.98, detail: "Publishing the verified engine package" },
});

function executableOnPath(name, environment = process.env, platform = process.platform) {
  const explicit = environment.CODEX_PERSONA_VOICE_UV_BIN?.trim();
  if (explicit) return path.isAbsolute(explicit) && fs.existsSync(explicit) ? explicit : null;
  const pathApi = platform === "win32" ? path.win32 : path;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of String(environment.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = pathApi.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveEngineStoragePaths({
  packaged,
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
  projectRoot,
  userDataDirectory,
  userDataOverridden = false,
  productDirectory = "Codex Persona Voice",
  productSlug = "codex-persona-voice",
} = {}) {
  if (!packaged) {
    const storageRoot = path.join(projectRoot, "runtime");
    return {
      runtimeRoot: path.join(storageRoot, "seed-vc"),
      pythonRoot: path.join(storageRoot, "python"),
      cacheRoot: path.join(storageRoot, "cache", "uv"),
      tempRoot: path.join(storageRoot, "temp", "engine-installer"),
    };
  }
  if (userDataOverridden) {
    const storageRoot = path.join(userDataDirectory, "engine");
    return {
      runtimeRoot: path.join(storageRoot, "seed-vc"),
      pythonRoot: path.join(storageRoot, "python"),
      cacheRoot: path.join(storageRoot, "cache", "uv"),
      tempRoot: path.join(storageRoot, "temp", "engine-installer"),
    };
  }
  if (platform === "win32") {
    const localAppData = typeof environment.LOCALAPPDATA === "string" &&
      path.win32.isAbsolute(environment.LOCALAPPDATA)
      ? path.win32.normalize(environment.LOCALAPPDATA)
      : path.win32.join(homeDirectory, "AppData", "Local");
    const storageRoot = path.win32.join(localAppData, productDirectory, "engine");
    return {
      runtimeRoot: path.win32.join(storageRoot, "seed-vc"),
      pythonRoot: path.win32.join(storageRoot, "python"),
      cacheRoot: path.win32.join(storageRoot, "cache", "uv"),
      tempRoot: path.win32.join(storageRoot, "temp", "engine-installer"),
    };
  }
  if (platform === "linux") {
    const dataHome = typeof environment.XDG_DATA_HOME === "string" && path.posix.isAbsolute(environment.XDG_DATA_HOME)
      ? path.posix.normalize(environment.XDG_DATA_HOME)
      : path.posix.join(homeDirectory, ".local", "share");
    const cacheHome = typeof environment.XDG_CACHE_HOME === "string" && path.posix.isAbsolute(environment.XDG_CACHE_HOME)
      ? path.posix.normalize(environment.XDG_CACHE_HOME)
      : path.posix.join(homeDirectory, ".cache");
    const storageRoot = path.posix.join(dataHome, productSlug, "engine");
    const cacheRoot = path.posix.join(cacheHome, productSlug);
    return {
      runtimeRoot: path.posix.join(storageRoot, "seed-vc"),
      pythonRoot: path.posix.join(storageRoot, "python"),
      cacheRoot: path.posix.join(cacheRoot, "uv"),
      tempRoot: path.posix.join(cacheRoot, "temp", "engine-installer"),
    };
  }
  const storageRoot = path.join(userDataDirectory, "engine");
  return {
    runtimeRoot: path.join(storageRoot, "seed-vc"),
    pythonRoot: path.join(storageRoot, "python"),
    cacheRoot: path.join(storageRoot, "cache", "uv"),
    tempRoot: path.join(storageRoot, "temp", "engine-installer"),
  };
}

function resolveEngineInstallerPaths({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
  runtimeRoot = path.join(projectRoot, "runtime", "seed-vc"),
  pythonRoot = null,
  cacheRoot = null,
  tempRoot = null,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const profile = resolveSeedVcRuntimeProfile(platform, arch);
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  const engineRoot = isPackaged
    ? path.join(resourcesPath, "engine", "seed-vc")
    : path.join(projectRoot, "engine", "seed-vc");
  const storageRoot = path.dirname(runtimeRoot);
  return {
    packaged: isPackaged,
    profile,
    platform,
    arch,
    uvPath: isPackaged
      ? path.join(resourcesPath, "engine-installer", uvName)
      : executableOnPath(uvName, environment, platform),
    runtimeRoot,
    stagingRoot: `${runtimeRoot}.installing`,
    backupRoot: `${runtimeRoot}.backup`,
    pythonRoot: pythonRoot || path.join(storageRoot, "python"),
    cacheRoot: cacheRoot || path.join(storageRoot, "cache", "uv"),
    tempRoot: tempRoot || path.join(storageRoot, "temp", "engine-installer"),
    requirementsPath: profile ? path.join(engineRoot, profile.requirementsFile) : null,
    modelLockPath: path.join(engineRoot, "model-lock.json"),
    prefetchPath: path.join(engineRoot, "prefetch.py"),
    verifierPath: path.join(engineRoot, "verify.py"),
    workerPath: path.join(engineRoot, "worker.py"),
    seedRoot: isPackaged
      ? path.join(resourcesPath, "engine", "vendor", "seed-vc")
      : path.join(projectRoot, "engine", "vendor", "seed-vc"),
  };
}

function runtimePaths(paths, runtimeRoot = paths.runtimeRoot) {
  const platform = paths.profile?.platform || paths.platform || process.platform;
  return {
    packaged: paths.packaged,
    profile: paths.profile,
    runtimeRoot,
    pythonPath: pythonPathForRuntime(runtimeRoot, platform),
    workerPath: paths.workerPath,
    seedRoot: paths.seedRoot,
    modelLockPath: paths.modelLockPath,
    requirementsPath: paths.requirementsPath,
    installManifestPath: path.join(runtimeRoot, "install-manifest.json"),
  };
}

function buildInstallerEnvironment(paths, environment = process.env, platform = process.platform) {
  const value = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof environment[key] === "string" && environment[key]) value[key] = environment[key];
  }
  const systemRoot = environment.SYSTEMROOT || environment.WINDIR;
  const systemPath = platform === "win32" && systemRoot
    ? [
      path.win32.join(systemRoot, "System32"),
      systemRoot,
      path.win32.join(systemRoot, "System32", "Wbem"),
    ].join(";")
    : platform === "win32" ? "" : "/usr/bin:/bin:/usr/sbin:/sbin";
  const temporaryEnvironment = platform === "win32"
    ? { TEMP: paths.tempRoot, TMP: paths.tempRoot }
    : { TMPDIR: paths.tempRoot };
  return {
    ...value,
    ...temporaryEnvironment,
    PATH: systemPath,
    LANG: "C",
    LC_ALL: "C",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    PIP_CONFIG_FILE: platform === "win32" ? "NUL" : "/dev/null",
    UV_NO_CONFIG: "1",
    UV_MANAGED_PYTHON: "1",
    UV_LINK_MODE: "copy",
    UV_NO_CACHE: "1",
    UV_DEFAULT_INDEX: "https://pypi.org/simple",
    UV_INDEX_STRATEGY: "first-index",
    UV_KEYRING_PROVIDER: "disabled",
    UV_REQUIRE_HASHES: "1",
    UV_CACHE_DIR: paths.cacheRoot,
    UV_PYTHON_INSTALL_DIR: paths.pythonRoot,
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
  };
}

async function terminateInstallerChild(child, {
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return terminateChild(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    try { await waitForExit(child, 5_000); return; }
    catch {}
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitForExit(child, 2_000);
    return;
  }
  const systemRoot = process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows";
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  const killer = spawnProcess(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  killer.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  const result = await waitForExit(killer, 10_000);
  if (result.code !== 0 && child.exitCode === null && child.signalCode === null) {
    throw new Error(stderr.trim() || `taskkill failed with exit code ${String(result.code)}`);
  }
  await waitForExit(child, 10_000);
}

function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(value);
    else if (entry.isFile()) total += fs.statSync(value).size;
  }
  return total;
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function cancelledError() {
  const error = new Error("Engine installation was cancelled; Retry resumes the partial download");
  error.code = "engine_install_cancelled";
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function resolveUvBuildConstraintArgument(requirementsPath, cwd) {
  const argument = path.relative(cwd, requirementsPath);
  if (!argument || path.isAbsolute(argument) || /\s/u.test(argument)) {
    throw new Error("The uv build-constraint path must be a non-whitespace relative path");
  }
  return argument;
}

function executeCommand({
  executable,
  args,
  cwd,
  environment,
  signal,
  platform = process.platform,
  spawnProcess = spawn,
  terminateProcess = null,
  onOutput = () => {},
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const child = spawnProcess(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    });
    let settled = false;
    let aborting = false;
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const consume = (chunk, isError) => {
      const text = chunk.toString("utf8");
      if (isError) stderr = (stderr + text).slice(-32_000);
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        onOutput(line.slice(0, 2_000));
      }
    };
    const onAbort = () => {
      if (aborting || settled) return;
      aborting = true;
      const terminate = terminateProcess || ((target) => terminateInstallerChild(target, { platform }));
      Promise.resolve(terminate(child)).then(
        () => finish(cancelledError()),
        (error) => finish(new Error(
          `Engine installation cancellation could not terminate its child process: ${error.message}`,
        )),
      );
    };
    child.stdout?.on("data", (chunk) => consume(chunk, false));
    child.stderr?.on("data", (chunk) => consume(chunk, true));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, childSignal) => {
      if (aborting) return;
      if (code === 0) finish();
      else finish(new Error(
        stderr.trim() ||
        `${path.basename(executable)} failed (code=${String(code)}, signal=${String(childSignal)})`,
      ));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class EngineInstaller {
  constructor({
    paths,
    platform = process.platform,
    arch = process.arch,
    environment = process.env,
    execute = executeCommand,
    freeBytes = availableBytes,
    size = directorySize,
    publish = () => {},
    logger = null,
  }) {
    this.profile = resolveSeedVcRuntimeProfile(platform, arch);
    this.paths = { ...paths, profile: paths.profile || this.profile, platform, arch };
    this.platform = platform;
    this.arch = arch;
    this.environment = environment;
    this.execute = execute;
    this.freeBytes = freeBytes;
    this.size = size;
    this.publish = publish;
    this.logger = logger;
    this.operation = null;
    this.abortController = null;
    this.recoveryError = null;
    try { this.recoverInterruptedPublish(); }
    catch (error) { this.recoveryError = error; }
    this.state = this.initialState();
  }

  recoverInterruptedPublish() {
    if (!fs.existsSync(this.paths.backupRoot)) return;
    const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
    if (installed.ready) {
      fs.rmSync(this.paths.backupRoot, { recursive: true, force: true });
      this.logger?.warn?.("engine.install_recovered_published_runtime");
      return;
    }
    const backup = inspectSeedVcRuntime(runtimePaths(this.paths, this.paths.backupRoot));
    if (!backup.ready) {
      throw new Error(
        `An interrupted engine update could not be recovered: ${backup.detail}`,
      );
    }
    if (fs.existsSync(this.paths.runtimeRoot)) {
      fs.rmSync(this.paths.runtimeRoot, { recursive: true, force: true });
    }
    fs.renameSync(this.paths.backupRoot, this.paths.runtimeRoot);
    this.logger?.warn?.("engine.install_restored_previous_runtime");
  }

  supported() {
    return this.profile !== null && this.paths.profile?.id === this.profile.id &&
      typeof this.paths.requirementsPath === "string" &&
      path.basename(this.paths.requirementsPath) === this.profile.requirementsFile &&
      fs.existsSync(this.paths.requirementsPath) &&
      typeof this.paths.uvPath === "string" && fs.existsSync(this.paths.uvPath);
  }

  initialState() {
    const estimatedInstalledBytes = this.profile?.estimatedInstalledBytes || ESTIMATED_INSTALLED_BYTES;
    const minimumFreeBytes = this.profile?.minimumFreeBytes || MIN_INSTALL_FREE_BYTES;
    if (!this.profile) {
      return {
        status: "unavailable",
        detail: "Realtime Seed-VC requires Apple Silicon or x64 Windows/Linux with NVIDIA CUDA; CPU inference is not a qualified realtime profile",
        estimatedInstalledBytes,
        minimumFreeBytes,
      };
    }
    if (this.paths.profile?.id !== this.profile.id ||
        typeof this.paths.requirementsPath !== "string" ||
        path.basename(this.paths.requirementsPath || "") !== this.profile.requirementsFile ||
        !fs.existsSync(this.paths.requirementsPath)) {
      return {
        status: "unavailable",
        detail: `The locked ${this.profile.deviceLabel} runtime profile is missing`,
        estimatedInstalledBytes,
        minimumFreeBytes,
      };
    }
    if (typeof this.paths.uvPath !== "string" || !fs.existsSync(this.paths.uvPath)) {
      return {
        status: "unavailable",
        detail: "The verified engine installer bootstrap is missing",
        estimatedInstalledBytes,
        minimumFreeBytes,
      };
    }
    if (this.recoveryError) {
      return {
        status: "error",
        detail: this.recoveryError instanceof Error
          ? this.recoveryError.message
          : String(this.recoveryError),
        resumable: fs.existsSync(this.paths.stagingRoot),
        estimatedInstalledBytes,
        minimumFreeBytes,
      };
    }
    const runtime = inspectSeedVcRuntime(runtimePaths(this.paths));
    if (runtime.ready) {
      return {
        status: "ready",
        detail: runtime.detail,
        installedBytes: this.installedFootprint(),
        estimatedInstalledBytes,
        minimumFreeBytes,
      };
    }
    return {
      status: "idle",
      detail: fs.existsSync(this.paths.stagingRoot)
        ? "A partial engine package is ready to resume"
        : "The separate Seed-VC engine package is not installed",
      resumable: fs.existsSync(this.paths.stagingRoot),
      estimatedInstalledBytes,
      minimumFreeBytes,
    };
  }

  getState() {
    return this.state;
  }

  transition(next) {
    this.state = {
      ...next,
      estimatedInstalledBytes: this.profile?.estimatedInstalledBytes || ESTIMATED_INSTALLED_BYTES,
      minimumFreeBytes: this.profile?.minimumFreeBytes || MIN_INSTALL_FREE_BYTES,
    };
    this.publish(this.state);
    return this.state;
  }

  phase(phase, output = null) {
    const descriptor = PHASES[phase];
    return this.transition({
      status: "installing",
      phase,
      progress: descriptor.progress,
      detail: output || descriptor.detail,
      cancellable: phase !== "publishing",
    });
  }

  installedFootprint(runtimeRoot = this.paths.runtimeRoot) {
    return this.size(runtimeRoot) + this.size(this.paths.pythonRoot) +
      this.size(this.paths.cacheRoot) + this.size(this.paths.tempRoot);
  }

  transactionFootprint() {
    return [
      this.paths.runtimeRoot,
      this.paths.stagingRoot,
      this.paths.backupRoot,
      this.paths.pythonRoot,
      this.paths.cacheRoot,
      this.paths.tempRoot,
    ].reduce((total, target) => total + this.size(target), 0);
  }

  enforceFootprint(runtimeRoot) {
    const bytes = this.installedFootprint(runtimeRoot);
    if (bytes > MAX_RUNTIME_BYTES) {
      throw new Error(
        `Installed engine is ${(bytes / 1024 ** 3).toFixed(2)} GiB, above the 15 GiB product limit`,
      );
    }
    return bytes;
  }

  enforceTransactionFootprint() {
    const bytes = this.transactionFootprint();
    if (bytes > MAX_INSTALL_TRANSACTION_BYTES) {
      throw new Error(
        `Engine installation transaction is ${(bytes / 1024 ** 3).toFixed(2)} GiB, above the 20 GiB hard limit; remove the previous engine package before reinstalling`,
      );
    }
    return bytes;
  }

  async command(executable, args, signal, phase) {
    await this.execute({
      executable,
      args,
      cwd: this.paths.seedRoot,
      environment: buildInstallerEnvironment(this.paths, this.environment, this.platform),
      signal,
      platform: this.platform,
      onOutput: (line) => {
        this.logger?.debug?.("engine.install_output", { phase, message: line });
      },
    });
  }

  install() {
    if (this.operation) throw new Error("An engine package operation is already active");
    if (!this.supported()) throw new Error(this.initialState().detail);
    const controller = new AbortController();
    this.abortController = controller;
    const operation = this.installPackage(controller.signal);
    this.operation = operation;
    return operation.finally(() => {
      if (this.operation === operation) this.operation = null;
      if (this.abortController === controller) this.abortController = null;
    });
  }

  async installPackage(signal) {
    try {
      if (this.recoveryError) throw this.recoveryError;
      const parent = path.dirname(this.paths.runtimeRoot);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(parent, 0o700); } catch {}
      const minimumFreeBytes = this.profile.minimumFreeBytes;
      if (this.freeBytes(parent) < minimumFreeBytes) {
        throw new Error(
          `Seed-VC ${this.profile.deviceLabel} installation requires at least ${Math.ceil(minimumFreeBytes / 1024 ** 3)} GiB of free disk space`,
        );
      }
      const lock = JSON.parse(fs.readFileSync(this.paths.modelLockPath, "utf8"));
      if (lock.schemaVersion !== 1 || typeof lock.python !== "string") {
        throw new Error("The bundled Seed-VC model lock is invalid");
      }
      fs.mkdirSync(this.paths.stagingRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.paths.cacheRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.paths.tempRoot, { recursive: true, mode: 0o700 });
      const stagingPython = pythonPathForRuntime(this.paths.stagingRoot, this.platform);
      throwIfCancelled(signal);
      this.phase("preparing");
      await this.command(this.paths.uvPath, ["--version"], signal, "preparing");
      throwIfCancelled(signal);
      this.phase("python");
      await this.command(this.paths.uvPath, [
        "venv", "--managed-python", "--relocatable", "--allow-existing",
        "--python", lock.python, path.join(this.paths.stagingRoot, ".venv"),
      ], signal, "python");
      throwIfCancelled(signal);
      this.phase("packages");
      const buildConstraint = resolveUvBuildConstraintArgument(
        this.paths.requirementsPath,
        this.paths.seedRoot,
      );
      const packageArgs = [
        "pip", "sync", "--managed-python", "--strict", "--require-hashes",
        "--only-binary", ":all:",
        "--no-binary", "antlr4-python3-runtime",
        "--no-binary", "argbind",
        "--no-binary", "randomname",
        "--build-constraint", buildConstraint,
        "--link-mode", "copy",
        "--default-index", "https://pypi.org/simple",
      ];
      if (this.profile.torchBackend) {
        packageArgs.push("--torch-backend", this.profile.torchBackend);
      }
      packageArgs.push("--python", stagingPython, this.paths.requirementsPath);
      await this.command(this.paths.uvPath, packageArgs, signal, "packages");
      throwIfCancelled(signal);
      this.phase("hardware");
      await this.command(stagingPython, [
        "-I", "-u", this.paths.verifierPath,
        "--runtime-root", this.paths.stagingRoot,
        "--lock", this.paths.modelLockPath,
        "--worker", this.paths.workerPath,
        "--runtime-profile", this.profile.id,
        "--requirements-lock", this.paths.requirementsPath,
        "--device", this.profile.device,
        "--device-only",
      ], signal, "hardware");
      throwIfCancelled(signal);
      this.enforceFootprint(this.paths.stagingRoot);
      this.enforceTransactionFootprint();
      this.phase("models");
      await this.command(stagingPython, [
        "-I", "-u", this.paths.prefetchPath,
        "--runtime-root", this.paths.stagingRoot,
        "--lock", this.paths.modelLockPath,
        "--runtime-profile", this.profile.id,
        "--requirements-lock", this.paths.requirementsPath,
      ], signal, "models");
      throwIfCancelled(signal);
      this.enforceFootprint(this.paths.stagingRoot);
      this.enforceTransactionFootprint();
      this.phase("verifying");
      await this.command(stagingPython, [
        "-I", "-u", this.paths.verifierPath,
        "--runtime-root", this.paths.stagingRoot,
        "--lock", this.paths.modelLockPath,
        "--worker", this.paths.workerPath,
        "--runtime-profile", this.profile.id,
        "--requirements-lock", this.paths.requirementsPath,
        "--device", this.profile.device,
      ], signal, "verifying");
      throwIfCancelled(signal);
      const staged = inspectSeedVcRuntime(runtimePaths(this.paths, this.paths.stagingRoot));
      if (!staged.ready) throw new Error(staged.detail);
      for (const disposable of [this.paths.cacheRoot, this.paths.tempRoot]) {
        fs.rmSync(disposable, { recursive: true, force: true });
        if (fs.existsSync(disposable)) {
          throw new Error(`Engine installer could not remove ${disposable}`);
        }
      }
      const finalBytes = this.enforceFootprint(this.paths.stagingRoot);
      this.enforceTransactionFootprint();
      this.phase("publishing");
      throwIfCancelled(signal);
      const hadRuntime = fs.existsSync(this.paths.runtimeRoot);
      if (fs.existsSync(this.paths.backupRoot)) {
        throw new Error("A previous engine publication backup is still present");
      }
      if (hadRuntime) fs.renameSync(this.paths.runtimeRoot, this.paths.backupRoot);
      try {
        fs.renameSync(this.paths.stagingRoot, this.paths.runtimeRoot);
        const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
        if (!installed.ready) throw new Error(installed.detail);
      } catch (error) {
        let rollbackError = null;
        try {
          if (fs.existsSync(this.paths.runtimeRoot) && !fs.existsSync(this.paths.stagingRoot)) {
            fs.renameSync(this.paths.runtimeRoot, this.paths.stagingRoot);
          }
          if (hadRuntime && fs.existsSync(this.paths.backupRoot) &&
              !fs.existsSync(this.paths.runtimeRoot)) {
            fs.renameSync(this.paths.backupRoot, this.paths.runtimeRoot);
          }
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure;
        }
        if (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
            `restoring the previous engine also failed: ${rollbackError.message}`,
          );
        }
        throw error;
      }
      if (hadRuntime) {
        fs.rmSync(this.paths.backupRoot, { recursive: true, force: true });
        if (fs.existsSync(this.paths.backupRoot)) {
          throw new Error("The previous engine backup could not be removed after publication");
        }
      }
      const installed = inspectSeedVcRuntime(runtimePaths(this.paths));
      this.enforceFootprint(this.paths.runtimeRoot);
      this.logger?.info?.("engine.install_completed", { bytes: finalBytes });
      return this.transition({
        status: "ready",
        detail: installed.detail,
        installedBytes: finalBytes,
      });
    } catch (error) {
      if (error?.code === "engine_install_cancelled") {
        this.logger?.info?.("engine.install_cancelled");
        this.transition({
          status: "idle",
          detail: "Installation paused; Retry resumes the partial engine package",
          resumable: true,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error?.("engine.install_failed", { message });
        this.transition({
          status: "error",
          detail: message,
          resumable: fs.existsSync(this.paths.stagingRoot),
        });
      }
      throw error;
    }
  }

  async cancel() {
    if (!this.operation || !this.abortController) return false;
    this.abortController.abort();
    await this.operation.catch(() => {});
    return true;
  }

  async remove() {
    if (this.operation) throw new Error("An engine package operation is already active");
    const operation = (async () => {
      this.transition({ status: "removing", detail: "Removing the local engine package" });
      try {
        for (const target of [
          this.paths.runtimeRoot,
          this.paths.stagingRoot,
          this.paths.backupRoot,
          this.paths.pythonRoot,
          this.paths.cacheRoot,
          this.paths.tempRoot,
        ]) {
          fs.rmSync(target, { recursive: true, force: true });
        }
        this.recoveryError = null;
        return this.transition({
          status: "idle",
          detail: "The separate Seed-VC engine package is not installed",
          resumable: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.transition({ status: "error", detail: message, resumable: false });
        throw error;
      }
    })();
    this.operation = operation;
    try { return await operation; }
    finally { if (this.operation === operation) this.operation = null; }
  }

  async shutdown() {
    await this.cancel();
  }
}

module.exports = {
  ESTIMATED_INSTALLED_BYTES,
  EngineInstaller,
  MAX_RUNTIME_BYTES,
  MAX_INSTALL_TRANSACTION_BYTES,
  MIN_INSTALL_FREE_BYTES,
  UV_VERSION,
  buildInstallerEnvironment,
  executeCommand,
  resolveEngineInstallerPaths,
  resolveEngineStoragePaths,
  resolveUvBuildConstraintArgument,
  runtimePaths,
  throwIfCancelled,
};
