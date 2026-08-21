"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { NativeFrameParser } = require("./native-protocol.cjs");

const HELPER_NAMES = Object.freeze({
  capture: "cpv-audio-capture",
  output: "cpv-audio-output",
  route: "cpv-audio-route",
});

const HELPER_DIRECTORIES = Object.freeze({
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
});

function resolveNativeHelperPath(kind, {
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
} = {}) {
  const baseName = HELPER_NAMES[kind];
  const directory = HELPER_DIRECTORIES[platform];
  const name = platform === "win32" ? `${baseName}.exe` : baseName;
  if (!baseName) throw new Error(`Unknown native helper kind: ${String(kind)}`);
  if (!directory) return null;
  return isPackaged
    ? path.join(resourcesPath, "native", directory, name)
    : path.join(projectRoot, "native", "bin", directory, name);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Native helper did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function terminateChild(child, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, timeoutMs);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    try { await waitForExit(child, 1_000); }
    catch {
      throw error;
    }
  }
}

function probeNativeHelper(executable, expectedHelper, {
  spawnProcess = spawn,
  timeoutMs = 3_000,
  args = ["--self-test"],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let message = null;
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill?.("SIGKILL");
        reject(error);
      }
      else resolve(value);
    };
    const parser = new NativeFrameParser((candidate) => {
      if (candidate.type === "error") {
        finish(new Error(candidate.message || `${expectedHelper} native self-test failed`));
      } else if (candidate.type === "ready") {
        message = candidate;
      }
    });
    child.stdout.on("data", (chunk) => {
      try { parser.push(chunk); }
      catch (error) { finish(error); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      try { parser.finish(); }
      catch (error) { finish(error); return; }
      if (code !== 0 || !message || message.helper !== expectedHelper || message.protocolVersion !== 1) {
        finish(new Error(
          stderr.trim() || `${expectedHelper} native self-test failed (code=${String(code)}, signal=${String(signal)})`,
        ));
        return;
      }
      finish(null, message);
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${expectedHelper} native self-test timed out`));
    }, timeoutMs);
    timer.unref?.();
  });
}

module.exports = {
  HELPER_NAMES,
  HELPER_DIRECTORIES,
  probeNativeHelper,
  resolveNativeHelperPath,
  terminateChild,
  waitForExit,
};
