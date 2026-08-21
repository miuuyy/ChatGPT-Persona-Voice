"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function executableExtensions(platform, environment) {
  if (platform !== "win32") return [""];
  return (environment.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

function findExecutable(command, {
  platform = process.platform,
  environment = process.env,
  exists = fs.existsSync,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const explicit = command === "codex" ? environment.CODEX_PERSONA_VOICE_CODEX_BIN?.trim() : null;
  if (explicit) {
    if (!pathApi.isAbsolute(explicit)) throw new Error("CODEX_PERSONA_VOICE_CODEX_BIN must be absolute");
    return exists(explicit) ? explicit : null;
  }
  const pathValue = environment.PATH || "";
  const extensions = executableExtensions(platform, environment);
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, platform === "win32" ? `${command}${extension}` : command);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value).trim());
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function versionAtLeast(value, minimum) {
  const actualParts = parseVersion(value);
  const minimumParts = parseVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

function macProductVersion() {
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1_500,
    }).trim();
  } catch {
    return null;
  }
}

function probePlatformCapabilities({
  platform = process.platform,
  environment = process.env,
  release = os.release(),
  macVersion = platform === "darwin" ? macProductVersion() : null,
  exists = fs.existsSync,
  helperPaths = {},
} = {}) {
  const codexPath = findExecutable("codex", { platform, environment, exists });
  const base = {
    platform,
    release,
    codex: {
      detected: Boolean(codexPath),
      executable: codexPath,
      detail: codexPath ? `Codex CLI found at ${codexPath}` : "Codex CLI is not present on the launcher PATH",
    },
    ownedSession: {
      possible: true,
      ready: false,
      code: "codex_app_server_bridge_missing",
      detail: "The App Server realtime bridge is specified but not bundled in this milestone",
    },
    desktopCapture: {
      possible: false,
      ready: false,
      code: "desktop_capture_unsupported",
      detail: "Process audio capture is not available on this platform",
    },
    suppression: {
      possible: false,
      ready: false,
      code: "source_suppression_unsupported",
      detail: "No verified route can suppress the original application audio",
    },
    engine: {
      ready: false,
      code: "engine_not_installed",
      detail: "No local voice conversion engine is configured",
    },
    output: {
      ready: false,
      code: "output_adapter_missing",
      detail: "The converted-audio output adapter is not bundled in this milestone",
    },
  };

  if (platform === "darwin") {
    const supported = macVersion ? versionAtLeast(macVersion, "14.2") : false;
    const captureBuilt = supported && typeof helperPaths.capture === "string" && exists(helperPaths.capture);
    const outputBuilt = supported && typeof helperPaths.output === "string" && exists(helperPaths.output);
    base.macVersion = macVersion;
    base.desktopCapture = {
      possible: supported,
      ready: captureBuilt,
      code: captureBuilt ? "ready" : supported ? "macos_process_tap_helper_missing" : "macos_14_2_required",
      detail: captureBuilt
        ? "Native Core Audio PCM capture helper is built"
        : supported
          ? "Core Audio process taps are available; the PCM helper is not built"
        : "Transparent process capture requires macOS 14.2 or newer",
    };
    base.suppression = {
      possible: supported,
      ready: captureBuilt,
      code: captureBuilt ? "ready" : supported ? "macos_muted_tap_helper_missing" : "macos_14_2_required",
      detail: captureBuilt
        ? "Capture helper uses CATapMutedWhenTapped to suppress original playback"
        : supported
          ? "Muted process taps can enforce suppression; the native helper is not built"
        : "Muted Core Audio process taps require macOS 14.2 or newer",
    };
    base.output = {
      ready: outputBuilt,
      code: outputBuilt ? "ready" : "macos_output_helper_missing",
      detail: outputBuilt
        ? "Native bounded Core Audio output helper is built"
        : "The native converted-audio output helper is not built",
    };
  } else if (platform === "linux") {
    const requiredTools = ["pw-dump", "wireplumber"];
    const tools = Object.fromEntries(requiredTools.map((tool) => [
      tool,
      findExecutable(tool, { platform, environment, exists }),
    ]));
    const pipeWireReady = Object.values(tools).every(Boolean);
    const captureBuilt = typeof helperPaths.capture === "string" && exists(helperPaths.capture);
    const outputBuilt = typeof helperPaths.output === "string" && exists(helperPaths.output);
    base.pipeWireTools = tools;
    base.desktopCapture = {
      possible: pipeWireReady,
      ready: pipeWireReady && captureBuilt,
      code: !pipeWireReady ? "pipewire_tools_missing"
        : captureBuilt ? "ready" : "linux_capture_helper_missing",
      detail: !pipeWireReady
        ? "pw-dump and WirePlumber must be installed"
        : captureBuilt
          ? "The native PipeWire capture helper is built; runtime policy is verified separately"
          : "The native PipeWire capture helper is not built",
    };
    base.suppression = {
      possible: pipeWireReady,
      ready: false,
      code: pipeWireReady && captureBuilt ? "linux_policy_probe_required" :
        pipeWireReady ? "linux_capture_helper_missing" : "pipewire_tools_missing",
      detail: pipeWireReady
        ? "The owned WirePlumber ingress policy must pass its live activation probe"
        : "An isolated route requires pw-dump and WirePlumber",
    };
    base.output = {
      ready: outputBuilt,
      code: outputBuilt ? "ready" : "linux_output_helper_missing",
      detail: outputBuilt
        ? "The native bounded PipeWire output helper is built"
        : "The native PipeWire output helper is not built",
    };
  } else if (platform === "win32") {
    const build = Number(String(release).split(".").at(-1));
    const supported = Number.isInteger(build) && build >= 20_348;
    const captureBuilt = supported && typeof helperPaths.capture === "string" && exists(helperPaths.capture);
    const routeBuilt = supported && typeof helperPaths.route === "string" && exists(helperPaths.route);
    const outputBuilt = supported && typeof helperPaths.output === "string" && exists(helperPaths.output);
    base.windowsBuild = Number.isInteger(build) ? build : null;
    base.desktopCapture = {
      possible: supported,
      ready: captureBuilt,
      code: !supported ? "windows_build_20348_required"
        : captureBuilt ? "ready" : "windows_capture_helper_missing",
      detail: !supported
        ? "Process-scoped WASAPI loopback requires Windows build 20348 or newer"
        : captureBuilt
          ? "The native process-scoped WASAPI capture helper is built"
          : "The native WASAPI capture helper is not built",
    };
    base.suppression = {
      possible: supported,
      ready: false,
      code: routeBuilt ? "windows_sink_probe_required" :
        supported ? "windows_route_helper_missing" : "windows_build_20348_required",
      detail: routeBuilt
        ? "VB-CABLE Input and the selected app route must pass their live proof"
        : supported
          ? "The native Windows route verifier is not built"
          : "The Windows virtual-route profile requires build 20348 or newer",
    };
    base.output = {
      ready: outputBuilt,
      code: outputBuilt ? "ready" : supported ? "windows_output_helper_missing" : "windows_build_20348_required",
      detail: outputBuilt
        ? "The native bounded WASAPI output helper is built"
        : supported
          ? "The native WASAPI output helper is not built"
          : "The Windows output profile requires build 20348 or newer",
    };
  }

  return base;
}

module.exports = {
  findExecutable,
  parseVersion,
  probePlatformCapabilities,
  versionAtLeast,
};
