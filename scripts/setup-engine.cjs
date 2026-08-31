"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildInstallerEnvironment,
  resolveUvBuildConstraintArgument,
} = require("../electron/engine-installer.cjs");
const {
  pythonPathForRuntime,
  resolveSeedVcRuntimeProfile,
} = require("../electron/seed-vc-engine.cjs");

const root = path.join(__dirname, "..");
const engineRoot = path.join(root, "engine", "seed-vc");
const seedRoot = path.join(root, "engine", "vendor", "seed-vc");
const lockPath = path.join(engineRoot, "model-lock.json");
const profile = resolveSeedVcRuntimeProfile();
const requirementsPath = profile
  ? path.join(engineRoot, profile.requirementsFile)
  : null;
const requestedRootIndex = process.argv.indexOf("--runtime-root");
const runtimeRoot = requestedRootIndex >= 0
  ? path.resolve(process.argv[requestedRootIndex + 1] || "")
  : path.join(root, "runtime", "seed-vc");
const pythonPath = pythonPathForRuntime(runtimeRoot);
const MAX_RUNTIME_BYTES = 15 * 1024 ** 3;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: options.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function executableOnPath(name, environment = process.env) {
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(value);
    else if (entry.isFile()) total += fs.statSync(value).size;
  }
  return total;
}

if (!profile) {
  throw new Error("Realtime Seed-VC requires Apple Silicon or x64 Windows/Linux with NVIDIA CUDA; CPU inference is not a qualified realtime profile");
}
if (requestedRootIndex >= 0 && !process.argv[requestedRootIndex + 1]) {
  throw new Error("--runtime-root requires a path");
}
const uvPath = executableOnPath(process.platform === "win32" ? "uv.exe" : "uv");
if (!uvPath) throw new Error("The pinned uv engine installer is not available on PATH");
const setupEnvironment = buildInstallerEnvironment({
  cacheRoot: path.join(runtimeRoot, ".cache", "uv"),
  pythonRoot: path.join(runtimeRoot, "python"),
  tempRoot: path.join(runtimeRoot, ".temp", "engine-installer"),
}, process.env, process.platform);
fs.mkdirSync(setupEnvironment.UV_CACHE_DIR, { recursive: true, mode: 0o700 });
const setupTempRoot = setupEnvironment.TEMP || setupEnvironment.TMPDIR;
fs.mkdirSync(setupTempRoot, { recursive: true, mode: 0o700 });
run(uvPath, ["--version"], { capture: true, env: setupEnvironment });
if (!fs.existsSync(path.join(seedRoot, "real-time-gui.py"))) {
  throw new Error("Seed-VC submodule is missing; run git submodule update --init --recursive");
}
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const gitPath = executableOnPath(process.platform === "win32" ? "git.exe" : "git");
if (!gitPath) throw new Error("Git is required to verify the pinned Seed-VC source checkout");
const seedCommit = run(gitPath, ["rev-parse", "HEAD"], {
  cwd: seedRoot,
  capture: true,
  env: setupEnvironment,
});
if (seedCommit !== lock.seedVcCommit) {
  throw new Error(`Seed-VC submodule must be at ${lock.seedVcCommit}, found ${seedCommit}`);
}

fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
if (!fs.existsSync(pythonPath)) {
  run(uvPath, [
    "venv", "--managed-python", "--relocatable", "--python", lock.python,
    path.join(runtimeRoot, ".venv"),
  ], { env: setupEnvironment });
}
const packageArgs = [
  "pip", "sync", "--managed-python", "--strict", "--require-hashes",
  "--only-binary", ":all:",
  "--no-binary", "antlr4-python3-runtime",
  "--no-binary", "argbind",
  "--no-binary", "randomname",
  "--build-constraint", resolveUvBuildConstraintArgument(requirementsPath, root),
  "--link-mode", "copy",
  "--default-index", "https://pypi.org/simple",
];
if (profile.torchBackend) packageArgs.push("--torch-backend", profile.torchBackend);
packageArgs.push("--python", pythonPath, requirementsPath);
run(uvPath, packageArgs, { env: setupEnvironment });
run(pythonPath, [
  "-I", "-u", path.join(engineRoot, "verify.py"),
  "--runtime-root", runtimeRoot,
  "--lock", lockPath,
  "--worker", path.join(engineRoot, "worker.py"),
  "--runtime-profile", profile.id,
  "--requirements-lock", requirementsPath,
  "--device", profile.device,
  "--device-only",
], { env: setupEnvironment });
run(pythonPath, [
  "-I", "-u", path.join(engineRoot, "prefetch.py"),
  "--runtime-root", runtimeRoot,
  "--lock", lockPath,
  "--runtime-profile", profile.id,
  "--requirements-lock", requirementsPath,
], { env: setupEnvironment });

run(pythonPath, [
  "-I", "-u", path.join(engineRoot, "verify.py"),
  "--runtime-root", runtimeRoot,
  "--lock", lockPath,
  "--worker", path.join(engineRoot, "worker.py"),
  "--runtime-profile", profile.id,
  "--requirements-lock", requirementsPath,
  "--device", profile.device,
], { env: setupEnvironment });

for (const disposable of [path.join(runtimeRoot, ".cache", "uv"), setupTempRoot]) {
  fs.rmSync(disposable, { recursive: true, force: true });
  if (fs.existsSync(disposable)) throw new Error(`Engine setup could not remove ${disposable}`);
}
const bytes = directorySize(runtimeRoot);
if (bytes > MAX_RUNTIME_BYTES) {
  throw new Error(`Installed runtime is ${(bytes / 1024 ** 3).toFixed(2)} GiB, above the 15 GiB product limit`);
}
console.log(`Seed-VC runtime ready at ${runtimeRoot}`);
console.log(`Installed size: ${(bytes / 1024 ** 3).toFixed(2)} GiB`);
