"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EngineInstaller,
  MIN_INSTALL_FREE_BYTES,
  UV_VERSION,
  buildInstallerEnvironment,
  executeCommand,
  resolveEngineInstallerPaths,
  resolveEngineStoragePaths,
  resolveUvBuildConstraintArgument,
} = require("../electron/engine-installer.cjs");
const {
  pythonPathForRuntime,
  resolveSeedVcRuntimeProfile,
} = require("../electron/seed-vc-engine.cjs");

function fixture(t, {
  execute,
  platform = "darwin",
  arch = "arm64",
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-engine-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "Codex Persona Voice.app", "Contents", "Resources");
  const runtimeRoot = path.join(root, "engine", "seed-vc");
  const stagingRoot = `${runtimeRoot}.installing`;
  const profile = resolveSeedVcRuntimeProfile(platform, arch);
  const paths = {
    packaged: true,
    profile,
    platform,
    arch,
    uvPath: path.join(resources, "engine-installer", "uv"),
    runtimeRoot,
    stagingRoot,
    backupRoot: `${runtimeRoot}.backup`,
    pythonRoot: path.join(root, "engine", "python"),
    cacheRoot: path.join(root, "engine", "cache", "uv"),
    tempRoot: path.join(root, "engine", "temp", "engine-installer"),
    requirementsPath: path.join(resources, "engine", "seed-vc", profile.requirementsFile),
    modelLockPath: path.join(resources, "engine", "seed-vc", "model-lock.json"),
    prefetchPath: path.join(resources, "engine", "seed-vc", "prefetch.py"),
    verifierPath: path.join(resources, "engine", "seed-vc", "verify.py"),
    workerPath: path.join(resources, "engine", "seed-vc", "worker.py"),
    seedRoot: path.join(resources, "engine", "vendor", "seed-vc"),
  };
  for (const file of [
    paths.uvPath,
    paths.requirementsPath,
    paths.prefetchPath,
    paths.verifierPath,
    paths.workerPath,
    path.join(paths.seedRoot, "real-time-gui.py"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
  }
  fs.chmodSync(paths.uvPath, 0o755);
  const lockText = `${JSON.stringify({
    schemaVersion: 1,
    seedVcCommit: "a".repeat(40),
    python: "3.11",
    repositories: {
      "fixture/model": {
        files: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`model-${index}`, "hash"])),
      },
    },
  })}\n`;
  fs.writeFileSync(paths.modelLockPath, lockText);
  const requirementsText = "fixture requirements lock\n";
  fs.writeFileSync(paths.requirementsPath, requirementsText);
  const commands = [];
  const defaultExecute = async (command) => {
    commands.push(command);
    if (command.args[0] === "venv") {
      const python = pythonPathForRuntime(stagingRoot, platform);
      fs.mkdirSync(path.dirname(python), { recursive: true });
      fs.writeFileSync(python, "python");
    }
    if (command.args.includes(paths.prefetchPath)) {
      fs.writeFileSync(path.join(stagingRoot, "install-manifest.json"), `${JSON.stringify({
        schemaVersion: 2,
        runtimeProfile: profile.id,
        requirementsSha256: crypto.createHash("sha256").update(requirementsText).digest("hex"),
        modelLockSha256: crypto.createHash("sha256").update(lockText).digest("hex"),
        seedVcCommit: "a".repeat(40),
        python: "3.11",
        files: Array.from({ length: 7 }, (_, index) => ({ index })),
      })}\n`);
    }
  };
  const states = [];
  const installer = new EngineInstaller({
    paths,
    platform,
    arch,
    execute: execute || defaultExecute,
    freeBytes: () => profile.minimumFreeBytes + 1,
    size: () => 2_500_000_000,
    publish: (state) => states.push(state),
  });
  return { commands, installer, paths, root, stagingRoot, states, defaultExecute };
}

test("engine package installs in staging and publishes only after verification", async (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "keep until publish");
  const result = await value.installer.install();
  assert.equal(result.status, "ready");
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, "old-runtime")), false);
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, ".venv", "bin", "python")), true);
  assert.equal(fs.existsSync(path.join(value.paths.runtimeRoot, "install-manifest.json")), true);
  assert.deepEqual(value.states.filter((state) => state.status === "installing").map((state) => state.phase), [
    "preparing", "python", "packages", "hardware", "models", "verifying", "publishing",
  ]);
  assert.equal(value.commands[0].executable, value.paths.uvPath);
  assert.deepEqual(value.commands[0].args, ["--version"]);
  const packageCommand = value.commands.find((command) => command.args[0] === "pip");
  assert.ok(packageCommand);
  assert.equal(packageCommand.args.includes("--managed-python"), true);
  assert.equal(packageCommand.args.includes("--strict"), true);
  assert.equal(packageCommand.args.includes("--require-hashes"), true);
  assert.equal(packageCommand.args.at(packageCommand.args.indexOf("--only-binary") + 1), ":all:");
  assert.deepEqual(packageCommand.args.flatMap((argument, index) =>
    argument === "--no-binary" ? [packageCommand.args[index + 1]] : []), [
    "antlr4-python3-runtime",
    "argbind",
    "randomname",
  ]);
  const buildConstraint = packageCommand.args.at(packageCommand.args.indexOf("--build-constraint") + 1);
  assert.equal(buildConstraint, path.relative(value.paths.seedRoot, value.paths.requirementsPath));
  assert.equal(path.isAbsolute(buildConstraint), false);
  assert.equal(/\s/u.test(buildConstraint), false);
  assert.equal(path.resolve(packageCommand.cwd, buildConstraint), value.paths.requirementsPath);
  assert.equal(packageCommand.args.at(packageCommand.args.indexOf("--default-index") + 1), "https://pypi.org/simple");
  assert.equal(value.commands.some((command) => command.args.includes(value.paths.verifierPath)), true);
});

test("pinned uv accepts the packaged macOS build constraint path with spaces", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpv-uv-packaged-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "Codex Persona Voice.app", "Contents", "Resources");
  const runtimeRoot = path.join(root, "Library", "Application Support", "Codex Persona Voice", "engine", "seed-vc");
  const sourcePaths = resolveEngineInstallerPaths({
    isPackaged: false,
    projectRoot: path.join(__dirname, ".."),
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
  });
  assert.ok(sourcePaths.uvPath, `uv ${UV_VERSION} must be available on PATH`);
  const version = spawnSync(sourcePaths.uvPath, ["--version"], { encoding: "utf8", shell: false });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim().split(/\s+/)[1], UV_VERSION);

  const packagedPaths = resolveEngineInstallerPaths({
    isPackaged: true,
    resourcesPath,
    runtimeRoot,
    platform: "darwin",
    arch: "arm64",
  });
  for (const directory of [
    path.dirname(packagedPaths.uvPath),
    path.dirname(packagedPaths.requirementsPath),
    packagedPaths.seedRoot,
    packagedPaths.cacheRoot,
    packagedPaths.pythonRoot,
    packagedPaths.tempRoot,
  ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePaths.uvPath, packagedPaths.uvPath);
  fs.chmodSync(packagedPaths.uvPath, 0o755);
  fs.writeFileSync(packagedPaths.requirementsPath, "", { mode: 0o600 });

  const buildConstraint = resolveUvBuildConstraintArgument(
    packagedPaths.requirementsPath,
    packagedPaths.seedRoot,
  );
  await executeCommand({
    executable: packagedPaths.uvPath,
    args: [
      "pip", "sync", "--dry-run", "--system", "--allow-empty-requirements",
      "--build-constraint", buildConstraint,
      packagedPaths.requirementsPath,
    ],
    cwd: packagedPaths.seedRoot,
    environment: {
      ...buildInstallerEnvironment(packagedPaths, {}, "darwin"),
      UV_OFFLINE: "1",
    },
    platform: "darwin",
  });
});

test("uv build constraints fail closed when the relative path still contains whitespace", () => {
  assert.throws(
    () => resolveUvBuildConstraintArgument(
      "/private/resources/engine/locks with spaces/requirements.lock.txt",
      "/private/resources/engine/vendor/seed-vc",
    ),
    /non-whitespace relative path/,
  );
});

test("Linux x64 installs the locked CUDA profile without a CPU fallback", async (t) => {
  const value = fixture(t, { platform: "linux", arch: "x64" });
  const result = await value.installer.install();
  assert.equal(result.status, "ready");
  const packageCommand = value.commands.find((command) => command.args[0] === "pip");
  assert.equal(
    packageCommand.args.at(packageCommand.args.indexOf("--torch-backend") + 1),
    "cu130",
  );
  const deviceChecks = value.commands.filter((command) =>
    command.args.includes(value.paths.verifierPath));
  assert.equal(deviceChecks.length, 2);
  assert.equal(deviceChecks.every((command) =>
    command.args.at(command.args.indexOf("--device") + 1) === "cuda"), true);
  assert.equal(deviceChecks[0].args.includes("--device-only"), true);
  assert.equal(deviceChecks[1].args.includes("--device-only"), false);
});

test("installer resolves the Windows x64 CUDA lock, uv.exe, and venv layout", () => {
  const resolved = resolveEngineInstallerPaths({
    isPackaged: true,
    resourcesPath: "C:\\Program Files\\Persona Voice\\resources",
    projectRoot: "C:\\source",
    runtimeRoot: "C:\\Users\\person\\AppData\\Local\\Persona Voice\\engine\\seed-vc",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(resolved.profile.id, "windows-x64-cuda130");
  assert.equal(path.win32.basename(resolved.uvPath), "uv.exe");
  assert.equal(path.win32.basename(resolved.requirementsPath), "requirements-windows-x64-cuda.lock.txt");
  assert.equal(
    pythonPathForRuntime(resolved.runtimeRoot, "win32"),
    "C:\\Users\\person\\AppData\\Local\\Persona Voice\\engine\\seed-vc\\.venv\\Scripts\\python.exe",
  );
  assert.deepEqual(resolveEngineStoragePaths({
    packaged: true,
    platform: "win32",
    environment: { LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local" },
    homeDirectory: "C:\\Users\\person",
    userDataDirectory: "C:\\Users\\person\\AppData\\Roaming\\Codex Persona Voice",
  }), {
    runtimeRoot: "C:\\Users\\person\\AppData\\Local\\Codex Persona Voice\\engine\\seed-vc",
    pythonRoot: "C:\\Users\\person\\AppData\\Local\\Codex Persona Voice\\engine\\python",
    cacheRoot: "C:\\Users\\person\\AppData\\Local\\Codex Persona Voice\\engine\\cache\\uv",
    tempRoot: "C:\\Users\\person\\AppData\\Local\\Codex Persona Voice\\engine\\temp\\engine-installer",
  });
  assert.deepEqual(resolveEngineStoragePaths({
    packaged: true,
    platform: "linux",
    environment: { XDG_DATA_HOME: "/home/person/data", XDG_CACHE_HOME: "/home/person/cache" },
    homeDirectory: "/home/person",
    userDataDirectory: "/home/person/.config/Codex Persona Voice",
  }), {
    runtimeRoot: "/home/person/data/codex-persona-voice/engine/seed-vc",
    pythonRoot: "/home/person/data/codex-persona-voice/engine/python",
    cacheRoot: "/home/person/cache/codex-persona-voice/uv",
    tempRoot: "/home/person/cache/codex-persona-voice/temp/engine-installer",
  });
});

test("installer exposes no unmeasured CPU profile", (t) => {
  const value = fixture(t);
  const installer = new EngineInstaller({
    paths: value.paths,
    platform: "darwin",
    arch: "x64",
  });
  assert.equal(installer.supported(), false);
  assert.equal(installer.getState().status, "unavailable");
  assert.match(installer.getState().detail, /CPU inference is not a qualified realtime profile/);
});

test("cancelled engine installation keeps resumable staging and never replaces runtime", async (t) => {
  let packagesStarted;
  const atPackages = new Promise((resolve) => { packagesStarted = resolve; });
  let value;
  value = fixture(t, {
    execute: async (command) => {
      if (command.args[0] === "venv") {
        const python = path.join(value.stagingRoot, ".venv", "bin", "python");
        fs.mkdirSync(path.dirname(python), { recursive: true });
        fs.writeFileSync(python, "python");
        return;
      }
      if (command.args[0] !== "pip") return;
      packagesStarted();
      await new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("Engine installation was cancelled; Retry resumes the partial download");
          error.code = "engine_install_cancelled";
          reject(error);
        };
        command.signal.addEventListener("abort", fail, { once: true });
      });
    },
  });
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "old");
  const pending = value.installer.install();
  await atPackages;
  assert.equal(await value.installer.cancel(), true);
  await assert.rejects(pending, (error) => error.code === "engine_install_cancelled");
  assert.equal(fs.readFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "utf8"), "old");
  assert.equal(fs.existsSync(value.stagingRoot), true);
  assert.equal(value.installer.getState().status, "idle");
  assert.equal(value.installer.getState().resumable, true);
});

test("cancellation at the publication boundary leaves the previous runtime intact", async (t) => {
  const value = fixture(t);
  fs.mkdirSync(value.paths.runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "old");
  value.installer.publish = (state) => {
    value.states.push(state);
    if (state.status === "installing" && state.phase === "publishing") {
      value.installer.abortController.abort();
    }
  };
  await assert.rejects(
    value.installer.install(),
    (error) => error.code === "engine_install_cancelled",
  );
  assert.equal(fs.readFileSync(path.join(value.paths.runtimeRoot, "old-runtime"), "utf8"), "old");
  assert.equal(fs.existsSync(value.paths.backupRoot), false);
  assert.equal(fs.existsSync(value.stagingRoot), true);
});

test("an interrupted publication restores its previous verified runtime on next launch", async (t) => {
  const value = fixture(t);
  await value.installer.install();
  fs.renameSync(value.paths.runtimeRoot, value.paths.backupRoot);
  assert.equal(fs.existsSync(value.paths.runtimeRoot), false);

  const recovered = new EngineInstaller({
    paths: value.paths,
    platform: "darwin",
    arch: "arm64",
    execute: value.defaultExecute,
    freeBytes: () => MIN_INSTALL_FREE_BYTES + 1,
    size: () => 2_500_000_000,
  });
  assert.equal(recovered.getState().status, "ready");
  assert.equal(fs.existsSync(value.paths.runtimeRoot), true);
  assert.equal(fs.existsSync(value.paths.backupRoot), false);
});

test("a disk-space failure is explicit and is not presented as resumable", async (t) => {
  const value = fixture(t);
  value.installer.freeBytes = () => MIN_INSTALL_FREE_BYTES - 1;
  await assert.rejects(value.installer.install(), /at least 6 GiB/);
  assert.equal(value.installer.getState().status, "error");
  assert.equal(value.installer.getState().resumable, false);
});

test("the 15 GiB ceiling includes managed Python and fails before model download", async (t) => {
  const value = fixture(t);
  value.installer.size = (target) =>
    target === value.paths.pythonRoot ? 8 * 1024 ** 3 : 8 * 1024 ** 3;
  await assert.rejects(value.installer.install(), /above the 15 GiB product limit/);
  assert.equal(value.commands.some((command) => command.args.includes(value.paths.prefetchPath)), false);
});

test("engine storage bounds include disposable files and the previous-runtime transaction", async (t) => {
  const value = fixture(t);
  value.installer.size = () => 4 * 1024 ** 3;
  await assert.rejects(value.installer.install(), /above the 15 GiB product limit/);
  assert.equal(value.commands.some((command) => command.args.includes(value.paths.prefetchPath)), false);

  const update = fixture(t);
  update.installer.size = (target) => {
    if (target === update.paths.runtimeRoot || target === update.paths.stagingRoot) return 10 * 1024 ** 3;
    if (target === update.paths.pythonRoot) return 2 * 1024 ** 3;
    return 0;
  };
  await assert.rejects(update.installer.install(), /above the 20 GiB hard limit/);
  assert.equal(update.commands.some((command) => command.args.includes(update.paths.prefetchPath)), false);
});

test("engine package removal deletes runtime, partial downloads, managed Python, and cache", async (t) => {
  const value = fixture(t);
  for (const target of [
    value.paths.runtimeRoot,
    value.paths.stagingRoot,
    value.paths.backupRoot,
    value.paths.pythonRoot,
    value.paths.cacheRoot,
    value.paths.tempRoot,
  ]) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "payload"), "x");
  }
  const result = await value.installer.remove();
  assert.equal(result.status, "idle");
  for (const target of [
    value.paths.runtimeRoot,
    value.paths.stagingRoot,
    value.paths.backupRoot,
    value.paths.pythonRoot,
    value.paths.cacheRoot,
    value.paths.tempRoot,
  ]) assert.equal(fs.existsSync(target), false);
});

test("installer environment rejects Python, package-index, uv, loader, and Hugging Face injection", () => {
  const environment = buildInstallerEnvironment({
    cacheRoot: "/private/cache",
    pythonRoot: "/private/python",
    tempRoot: "/private/temp",
  }, {
    PATH: "/usr/bin",
    PYTHONPATH: "/tmp/injected",
    PIP_INDEX_URL: "https://attacker.invalid/simple",
    UV_DEFAULT_INDEX: "https://attacker.invalid/simple",
    UV_INDEX_URL: "https://attacker.invalid/simple",
    UV_CONSTRAINT: "/tmp/attacker-constraints.txt",
    UV_NO_VERIFY_HASHES: "1",
    UV_PYTHON_INSTALL_DIR: "/tmp/python",
    HF_ENDPOINT: "https://attacker.invalid",
    HF_TOKEN: "secret",
    SSL_CERT_FILE: "/tmp/attacker-ca.pem",
    HTTPS_PROXY: "https://attacker.invalid",
    OPENAI_API_KEY: "secret",
    DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
  }, "linux");
  assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(environment.PYTHONPATH, undefined);
  assert.equal(environment.PIP_INDEX_URL, undefined);
  assert.equal(environment.UV_INDEX_URL, undefined);
  assert.equal(environment.UV_CONSTRAINT, undefined);
  assert.equal(environment.UV_NO_VERIFY_HASHES, undefined);
  assert.equal(environment.HF_ENDPOINT, undefined);
  assert.equal(environment.HF_TOKEN, undefined);
  assert.equal(environment.SSL_CERT_FILE, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment.UV_NO_CONFIG, "1");
  assert.equal(environment.UV_MANAGED_PYTHON, "1");
  assert.equal(environment.UV_DEFAULT_INDEX, "https://pypi.org/simple");
  assert.equal(environment.UV_INDEX_STRATEGY, "first-index");
  assert.equal(environment.UV_KEYRING_PROVIDER, "disabled");
  assert.equal(environment.UV_REQUIRE_HASHES, "1");
  assert.equal(environment.UV_NO_CACHE, "1");
  assert.equal(environment.UV_CACHE_DIR, "/private/cache");
  assert.equal(environment.UV_PYTHON_INSTALL_DIR, "/private/python");
  assert.equal(environment.TMPDIR, "/private/temp");
  assert.equal(environment.HF_HUB_DISABLE_TELEMETRY, "1");
  assert.equal(environment.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
  const windowsEnvironment = buildInstallerEnvironment({
    cacheRoot: "C:\\cache",
    pythonRoot: "C:\\python",
    tempRoot: "C:\\temp",
  }, { SYSTEMROOT: "C:\\Windows" }, "win32");
  assert.equal(windowsEnvironment.TEMP, "C:\\temp");
  assert.equal(windowsEnvironment.TMP, "C:\\temp");
});
