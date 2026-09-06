"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function resolveChatterboxPaths({ isPackaged = false, resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."), runtimeRoot = path.join(projectRoot, "runtime", "chatterbox") } = {}) {
  const engineRoot = path.join(isPackaged ? resourcesPath : projectRoot, "engine", "chatterbox");
  return {
    engineRoot, runtimeRoot,
    pythonPath: path.join(runtimeRoot, ".venv", "bin", "python"),
    weightsPath: path.join(runtimeRoot, "weights"),
    workerPath: path.join(engineRoot, "worker.py"),
    installerPath: path.join(engineRoot, "install.py"),
    modelLockPath: path.join(engineRoot, "model-lock.json"),
    requirementsPath: path.join(engineRoot, "requirements-macos-arm64.lock.txt"),
    installManifestPath: path.join(runtimeRoot, "install-manifest.json"),
  };
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function inspectChatterboxRuntime(paths, platform = process.platform, arch = process.arch) {
  try {
    if (platform !== "darwin" || arch !== "arm64") throw new Error("Chatterbox requires Apple Silicon macOS");
    for (const file of [paths.pythonPath, paths.workerPath, paths.modelLockPath, paths.requirementsPath, paths.installManifestPath]) {
      if (!fs.existsSync(file)) throw new Error("Chatterbox is not installed; install it in Settings → Voice");
    }
    const lock = JSON.parse(fs.readFileSync(paths.modelLockPath, "utf8"));
    const installed = JSON.parse(fs.readFileSync(paths.installManifestPath, "utf8"));
    const checkpoint = path.join(paths.weightsPath, "s3gen.safetensors");
    if (installed.schemaVersion !== 1 || installed.profile !== lock.profile ||
        installed.modelLockSha256 !== sha256(paths.modelLockPath) ||
        installed.requirementsSha256 !== sha256(paths.requirementsPath) ||
        installed.modelSha256 !== lock.model.files["s3gen.safetensors"] ||
        !Number.isSafeInteger(installed.modelBytes) || installed.modelBytes <= 0 ||
        fs.statSync(checkpoint).size !== installed.modelBytes) {
      throw new Error("Chatterbox installation does not match its locked profile; reinstall it");
    }
    return { ready: true, code: "ready", detail: "Chatterbox · streaming · Apple MLX" };
  } catch (error) {
    return { ready: false, code: "chatterbox_unavailable", detail: error.message };
  }
}

module.exports = { resolveChatterboxPaths, inspectChatterboxRuntime };
