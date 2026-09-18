"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  DEFAULT_TARGET_APP,
  targetAppProcessPattern,
} = require("./target-apps.cjs");

const execFileAsync = promisify(execFile);
const DEFAULT_VOICE_APP_PATTERN = targetAppProcessPattern(DEFAULT_TARGET_APP);

function encoded(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function cleanLabel(value, fallback = "Application") {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized.slice(0, 160) || fallback;
}

function processIdentity(entry, platform) {
  const value = String(entry?.executable ?? "").trim();
  return platform === "win32" ? value.toLowerCase() : value;
}

function processSourceId(entry, platform) {
  const identity = processIdentity(entry, platform);
  return identity ? `process:${platform}:${encoded(identity)}` : null;
}

function hasAncestorInSet(pid, candidates, byId) {
  let current = byId.get(byId.get(pid)?.parentId);
  const visited = new Set([pid]);
  while (current && !visited.has(current.pid)) {
    if (candidates.has(current.pid)) return true;
    visited.add(current.pid);
    current = byId.get(current.parentId);
  }
  return false;
}

function branchBelowAncestor(ancestorPid, descendantPid, byId) {
  if (ancestorPid === descendantPid) return ancestorPid;
  let current = byId.get(descendantPid);
  const visited = new Set();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (current.parentId === ancestorPid) return current.pid;
    current = byId.get(current.parentId);
  }
  return null;
}

function descendantsOf(processes, roots) {
  const included = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (included.has(entry.parentId) && !included.has(entry.pid)) {
        included.add(entry.pid);
        changed = true;
      }
    }
  }
  return included;
}

function resolveProcessRoots(processes, roots, ownProcessId) {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  const candidates = new Set(roots);
  const rootPids = [...candidates]
    .filter((pid) => !hasAncestorInSet(pid, candidates, byId))
    .sort((left, right) => left - right);

  const excludedBranches = rootPids
    .map((rootPid) => branchBelowAncestor(rootPid, ownProcessId, byId))
    .filter((pid) => Number.isInteger(pid));
  const excluded = descendantsOf(processes, [ownProcessId, ...excludedBranches]);
  const included = descendantsOf(processes, rootPids);

  return {
    pids: processes
      .filter((entry) => included.has(entry.pid) && !excluded.has(entry.pid))
      .map((entry) => entry.pid)
      .sort((left, right) => left - right),
    rootPids: rootPids.filter((pid) => !excluded.has(pid)),
  };
}

function applicationBoundary(executable) {
  const value = String(executable ?? "").trim();
  const macBundle = /^(.+?\.app)(?:\/|$)/i.exec(value);
  if (macBundle) return { kind: "mac-bundle", prefix: `${macBundle[1]}/`, caseInsensitive: false };
  const windowsExecutable = /^(.*[\\/])[^\\/]+\.exe$/i.exec(value);
  if (windowsExecutable) {
    return { kind: "windows-directory", prefix: windowsExecutable[1].toLowerCase(), caseInsensitive: true };
  }
  return null;
}

function restrictToApplicationBoundaries(processes, tree) {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  const boundaries = tree.rootPids
    .map((pid) => ({ pid, ...applicationBoundary(byId.get(pid)?.executable) }))
    .filter((boundary) => boundary.prefix)
    .filter(Boolean);
  if (boundaries.length === 0) return tree;
  const pids = tree.pids.filter((pid) => {
    const executable = String(byId.get(pid)?.executable ?? "");
    return boundaries.some((boundary) => {
      if (pid === boundary.pid) return true;
      const value = boundary.caseInsensitive ? executable.toLowerCase() : executable;
      if (!value.startsWith(boundary.prefix)) return false;
      if (boundary.kind !== "mac-bundle") return true;
      return value.slice(boundary.prefix.length).includes(".app/Contents/MacOS/");
    });
  });
  return { pids, rootPids: tree.rootPids.filter((pid) => pids.includes(pid)) };
}

function parseMacProcesses(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentId: Number(match[2]),
      executable: match[3],
    }));
}

function parseWindowsProcesses(output) {
  if (!output.trim()) return [];
  const value = JSON.parse(output);
  return (Array.isArray(value) ? value : [value])
    .map((entry) => ({
      pid: Number(entry.ProcessId),
      parentId: Number(entry.ParentProcessId),
      executable: String(entry.ExecutablePath ?? entry.Name ?? ""),
      name: String(entry.Name ?? ""),
    }))
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0 && entry.executable);
}

function processSources(processes, platform, ownProcessId) {
  const ownTree = new Set([ownProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (ownTree.has(entry.parentId) && !ownTree.has(entry.pid)) {
        ownTree.add(entry.pid);
        changed = true;
      }
    }
  }
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  const unique = new Map();
  for (const entry of processes) {
    if (ownTree.has(entry.pid)) continue;
    const id = processSourceId(entry, platform);
    if (!id) continue;
    if (unique.has(id)) continue;
    const parts = entry.executable.split(separator);
    const name = cleanLabel(entry.name || parts.at(-1)).replace(/\.exe$/i, "");
    unique.set(id, {
      id,
      name,
      detail: cleanLabel(entry.executable, name),
      platform,
    });
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 500);
}

async function listPlatformProcesses({ platform = process.platform, run = execFileAsync } = {}) {
  if (platform === "darwin") {
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3_000,
    });
    return parseMacProcesses(stdout);
  }
  if (platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress";
    const { stdout } = await run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
    ], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    });
    return parseWindowsProcesses(stdout);
  }
  return [];
}

function selectedProcessTree(processes, platform, sourceId, ownProcessId = process.pid) {
  if (typeof sourceId !== "string" || !sourceId.startsWith(`process:${platform}:`)) {
    throw new Error("The selected process source id does not match this platform");
  }
  const roots = processes
    .filter((entry) => entry.pid !== ownProcessId && processSourceId(entry, platform) === sourceId)
    .map((entry) => entry.pid);
  if (roots.length === 0) return { pids: [], rootPids: [] };
  return resolveProcessRoots(processes, roots, ownProcessId);
}

function defaultVoiceProcessTree(
  processes,
  { pattern = DEFAULT_VOICE_APP_PATTERN, ownProcessId = process.pid } = {},
) {
  const ownTree = new Set([ownProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (ownTree.has(entry.parentId) && !ownTree.has(entry.pid)) {
        ownTree.add(entry.pid);
        changed = true;
      }
    }
  }
  const direct = new Set(processes
    .filter((entry) => {
      if (ownTree.has(entry.pid)) return false;
      pattern.lastIndex = 0;
      return pattern.test(`${entry.name || ""} ${entry.executable || ""}`);
    })
    .map((entry) => entry.pid));
  return restrictToApplicationBoundaries(
    processes,
    resolveProcessRoots(processes, [...direct], ownProcessId),
  );
}

async function resolveSelectedProcessTree({
  sourceId,
  platform = process.platform,
  run = execFileAsync,
  ownProcessId = process.pid,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Process-tree audio sources are available only on macOS and Windows");
  }
  const processes = await listPlatformProcesses({ platform, run });
  return selectedProcessTree(processes, platform, sourceId, ownProcessId);
}

async function resolveDefaultVoiceProcessTree({
  platform = process.platform,
  run = execFileAsync,
  ownProcessId = process.pid,
  targetApp = DEFAULT_TARGET_APP,
  pattern = null,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Automatic process-tree audio sources are available only on macOS and Windows");
  }
  const processes = await listPlatformProcesses({ platform, run });
  return defaultVoiceProcessTree(processes, {
    pattern: pattern ?? targetAppProcessPattern(targetApp),
    ownProcessId,
  });
}

function pipeWireSources(objects) {
  const clients = new Map(
    objects
      .filter((entry) => entry?.type === "PipeWire:Interface:Client")
      .map((entry) => [String(entry.id), entry?.info?.props ?? {}]),
  );
  const unique = new Map();
  for (const entry of objects) {
    if (entry?.type !== "PipeWire:Interface:Node") continue;
    const own = entry?.info?.props ?? {};
    if (own["media.class"] !== "Stream/Output/Audio") continue;
    const properties = { ...(clients.get(String(own["client.id"])) ?? {}), ...own };
    const identity = {
      application: cleanLabel(properties["application.name"], ""),
      binary: cleanLabel(properties["application.process.binary"], ""),
      node: cleanLabel(properties["node.name"], ""),
    };
    if (!identity.application && !identity.binary && !identity.node) continue;
    const id = `pipewire:stream:${encoded(JSON.stringify(identity))}`;
    unique.set(id, {
      id,
      name: identity.application || cleanLabel(properties["node.description"], identity.binary || identity.node),
      detail: [identity.binary, identity.node].filter(Boolean).join(" · "),
      platform: "linux",
    });
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 500);
}

async function listAudioSources({
  platform = process.platform,
  run = execFileAsync,
  ownProcessId = process.pid,
} = {}) {
  if (platform === "darwin") {
    const processes = await listPlatformProcesses({ platform, run });
    return { platform, sources: processSources(processes, platform, ownProcessId) };
  }
  if (platform === "win32") {
    const processes = await listPlatformProcesses({ platform, run });
    return { platform, sources: processSources(processes, platform, ownProcessId) };
  }
  if (platform === "linux") {
    const { stdout } = await run("pw-dump", [], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3_000,
    });
    return { platform, sources: pipeWireSources(JSON.parse(stdout)) };
  }
  return { platform, sources: [] };
}

module.exports = {
  DEFAULT_VOICE_APP_PATTERN,
  defaultVoiceProcessTree,
  listAudioSources,
  listPlatformProcesses,
  parseMacProcesses,
  parseWindowsProcesses,
  pipeWireSources,
  processSourceId,
  processSources,
  resolveSelectedProcessTree,
  resolveDefaultVoiceProcessTree,
  selectedProcessTree,
};
