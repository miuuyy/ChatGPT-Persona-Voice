"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const SOURCE_ROOT = path.join(PROJECT_ROOT, "native", "windows");
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "native", "bin", "win32");
const TARGETS = Object.freeze([
  "cpv-audio-capture.exe",
  "cpv-audio-output.exe",
  "cpv-audio-route.exe",
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() ||
      `${command} exited with ${String(result.status)}`);
  }
}

function cmakeArchitecture(architecture) {
  if (architecture === "x64") return "x64";
  if (architecture === "arm64") return "ARM64";
  throw new Error(`Windows native helpers support x64 and arm64, received ${architecture}`);
}

function buildWindowsNative({ platform = process.platform, architecture = process.arch } = {}) {
  if (platform !== "win32") throw new Error("Windows native helpers must be compiled on Windows");
  const cmakeArch = cmakeArchitecture(architecture);
  const buildRoot = path.join(SOURCE_ROOT, "build", architecture);
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  run("cmake", [
    "-S", SOURCE_ROOT,
    "-B", buildRoot,
    "-A", cmakeArch,
    "-D", "CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>",
  ]);
  run("cmake", ["--build", buildRoot, "--config", "Release", "--parallel"]);

  const outputs = [];
  for (const target of TARGETS) {
    const source = path.join(buildRoot, "Release", target);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`CMake did not produce ${source}`);
    }
    const output = path.join(OUTPUT_ROOT, target);
    fs.copyFileSync(source, output);
    outputs.push(output);
  }
  return outputs;
}

if (require.main === module) {
  try {
    for (const output of buildWindowsNative()) console.log(`Built ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { TARGETS, buildWindowsNative, cmakeArchitecture };
