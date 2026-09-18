"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const POLICY_VERSION = 3;
const NODE_PREFIX = "chatgpt-persona-voice";
const ASSET_ROOT = path.join(__dirname, "..", "native", "linux", "wireplumber");
const MANAGED_PATTERN = /^(?:#|--) Managed by ChatGPT Persona Voice; policy-version=\d+/;

const DEFAULT_ROUTES = Object.freeze([
  Object.freeze({
    id: "chatgpt",
    identities: Object.freeze([
      Object.freeze({ property: "application.name", value: "ChatGPT" }),
      Object.freeze({ property: "application.process.binary", value: "chatgpt" }),
      Object.freeze({ property: "application.process.binary", value: "chat-gpt" }),
    ]),
  }),
  Object.freeze({
    id: "codex",
    identities: Object.freeze([
      Object.freeze({ property: "application.name", value: "Codex" }),
      Object.freeze({ property: "application.name", value: "OpenAI Codex" }),
      Object.freeze({ property: "application.process.binary", value: "codex" }),
    ]),
  }),
  Object.freeze({
    id: "grok-bot",
    identities: Object.freeze([
      Object.freeze({ property: "application.name", value: "Grok Bot" }),
      Object.freeze({ property: "application.process.binary", value: "grok-bot" }),
      Object.freeze({ property: "application.process.binary", value: "grokbot" }),
    ]),
  }),
]);

function routeNode(kind, routeId) {
  return `${NODE_PREFIX}.${kind}.${routeId}`;
}

function resolvePolicyAssetRoot({
  resourcesPath = process.resourcesPath,
  exists = fs.existsSync,
} = {}) {
  const candidates = [];
  if (typeof resourcesPath === "string" && resourcesPath.trim()) {
    candidates.push(path.join(resourcesPath, "native", "linux", "wireplumber"));
  }
  candidates.push(ASSET_ROOT);
  const selected = candidates.find((candidate) =>
    exists(path.join(candidate, "0.4", "cpv-create-item.lua")) &&
    exists(path.join(candidate, "0.5", "cpv-policy.lua")));
  if (!selected) {
    throw new Error("Packaged Linux WirePlumber policy assets are missing");
  }
  return selected;
}

function homeDirectory(environment = process.env) {
  return environment.HOME?.trim() || os.homedir();
}

function configRoot(environment = process.env) {
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg && !path.isAbsolute(xdg)) throw new Error("XDG_CONFIG_HOME must be an absolute path");
  return xdg || path.join(homeDirectory(environment), ".config");
}

function dataRoot(environment = process.env) {
  const xdg = environment.XDG_DATA_HOME?.trim();
  if (xdg && !path.isAbsolute(xdg)) throw new Error("XDG_DATA_HOME must be an absolute path");
  return xdg || path.join(homeDirectory(environment), ".local", "share");
}

function stateRoot(environment = process.env) {
  const xdg = environment.XDG_STATE_HOME?.trim();
  if (xdg && !path.isAbsolute(xdg)) throw new Error("XDG_STATE_HOME must be an absolute path");
  return xdg || path.join(homeDirectory(environment), ".local", "state");
}

function policyPath(environment = process.env) {
  return path.join(configRoot(environment), "pipewire", "pipewire.conf.d", "90-chatgpt-persona-voice.conf");
}

function activationPath(environment = process.env) {
  return path.join(stateRoot(environment), "chatgpt-persona-voice", "linux-audio-policy.json");
}

function familyPolicyPaths(environment, family) {
  if (family === "0.4") {
    return [
      path.join(configRoot(environment), "wireplumber", "policy.lua.d", "89-chatgpt-persona-voice.lua"),
      path.join(configRoot(environment), "wireplumber", "scripts", "cpv-create-item.lua"),
    ];
  }
  return [
    path.join(configRoot(environment), "wireplumber", "wireplumber.conf.d", "90-chatgpt-persona-voice.conf"),
    path.join(dataRoot(environment), "wireplumber", "scripts", "cpv-policy.lua"),
  ];
}

function allPolicyPaths(environment) {
  return [policyPath(environment), ...familyPolicyPaths(environment, "0.4"), ...familyPolicyPaths(environment, "0.5")];
}

function quoted(value) {
  return JSON.stringify(String(value));
}

function normalizeIdentities(identities) {
  const allowedProperties = new Set(["application.name", "application.process.binary", "node.name"]);
  const unique = new Map();
  for (const identity of identities) {
    if (!identity || !allowedProperties.has(identity.property)) {
      throw new Error("Linux audio policy identities must use application.name, application.process.binary, or node.name");
    }
    const value = String(identity.value ?? "").trim();
    if (!value || value.length > 256 || /[\0\r\n]/.test(value)) {
      throw new Error("Linux audio policy identity values must contain 1-256 printable characters");
    }
    unique.set(`${identity.property}\0${value}`, { property: identity.property, value });
  }
  if (unique.size === 0) throw new Error("At least one Linux audio policy identity is required");
  return [...unique.values()];
}

function normalizeRoutes(routes = DEFAULT_ROUTES) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("At least one Linux audio route is required");
  }
  const ids = new Set();
  const identityOwners = new Map();
  return routes.map((route) => {
    const id = String(route?.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || ids.has(id)) {
      throw new Error("Linux audio route ids must be unique lowercase slugs");
    }
    ids.add(id);
    const identities = normalizeIdentities(route.identities);
    for (const identity of identities) {
      const key = `${identity.property}\0${identity.value}`;
      const owner = identityOwners.get(key);
      if (owner && owner !== id) {
        throw new Error(`Linux audio identity ${identity.property}=${identity.value} belongs to multiple routes`);
      }
      identityOwners.set(key, id);
    }
    return { id, identities };
  });
}

function renderPipeWireConfig(routes = DEFAULT_ROUTES) {
  const modules = normalizeRoutes(routes).map(({ id }) => `  {
    name = libpipewire-module-loopback
    args = {
      node.description = "ChatGPT Persona Voice ${id} ingress"
      audio.position = [ FL FR ]
      capture.props = {
        node.name = "${routeNode("ingress", id)}"
        node.description = "ChatGPT Persona Voice (${id})"
        media.class = "Audio/Sink"
        node.virtual = true
        node.pause-on-idle = false
        monitor.channel-volumes = true
        chatgpt.persona.voice.route = "${id}"
      }
      playback.props = {
        node.name = "${routeNode("bypass", id)}"
        node.description = "ChatGPT Persona Voice ${id} bypass"
        media.class = "Stream/Output/Audio"
        media.role = "Communication"
        node.passive = true
        node.autoconnect = true
        node.dont-reconnect = false
        stream.dont-remix = true
        chatgpt.persona.voice.route = "${id}"
      }
    }
  }`).join("\n");
  return `# Managed by ChatGPT Persona Voice; policy-version=${POLICY_VERSION}
# Persistent process ingress. WirePlumber routes matching playback nodes here
# before selecting any default target. While Persona is idle, the bypass stream
# forwards ingress PCM to the current physical default sink unchanged.
context.modules = [
${modules}
]
`;
}

function renderWirePlumber04Config(routes = DEFAULT_ROUTES) {
  const entries = normalizeRoutes(routes)
    .flatMap(({ id, identities }) => identities.map(({ property, value }) =>
      `  { route = ${quoted(id)}, property = ${quoted(property)}, value = ${quoted(value)} },`))
    .join("\n");
  return `-- Managed by ChatGPT Persona Voice; policy-version=${POLICY_VERSION}
-- WirePlumber 0.4 loads this immediately before 90-enable-all.lua. The stock
-- policy loader is retained except for the versioned create-item script, which
-- assigns matching streams to the owned ingress before SessionItem linking.
default_policy.policy["chatgpt-persona-voice.identities"] = {
${entries}
}

function default_policy.enable()
  if default_policy.enabled == false then return end

  load_module("si-node")
  load_module("si-audio-adapter")
  load_module("si-standard-link")
  load_module("si-audio-endpoint")
  load_module("default-nodes-api")
  load_module("mixer-api")

  load_script("static-endpoints.lua", default_policy.endpoints)
  load_script("cpv-create-item.lua", default_policy.policy)
  load_script("policy-node.lua", default_policy.policy)
  load_script("policy-endpoint-client.lua", default_policy.policy)
  load_script("policy-endpoint-client-links.lua", default_policy.policy)
  load_script("policy-endpoint-device.lua", default_policy.policy)
  load_script("policy-bluetooth.lua", bluetooth_policy.policy)
  load_script("policy-dsp.lua", dsp_policy.policy)
end
`;
}

function renderWirePlumber05Config(routes = DEFAULT_ROUTES) {
  const entries = normalizeRoutes(routes)
    .flatMap(({ id, identities }) => identities.map(({ property, value }) =>
      `  { route = ${quoted(id)} property = ${quoted(property)} value = ${quoted(value)} }`))
    .join("\n");
  return `# Managed by ChatGPT Persona Voice; policy-version=${POLICY_VERSION}
chatgpt_persona_voice.identities = [
${entries}
]

wireplumber.components = [
  {
    name = "cpv-policy.lua", type = script/lua
    provides = hooks.cpv.policy
  }
]

wireplumber.profiles = {
  main = {
    hooks.cpv.policy = required
  }
}
`;
}

function parseWirePlumberVersion(output) {
  const match = String(output).match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (!match) throw new Error("Unable to determine the installed WirePlumber version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor === 4) return { family: "0.4", version: match[0] };
  if (major === 0 && minor === 5) return { family: "0.5", version: match[0] };
  throw new Error(`WirePlumber ${match[0]} is not supported by the installed Linux audio policy`);
}

function detectWirePlumber({ run = execFileSync } = {}) {
  let output;
  try {
    output = run("wireplumber", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`WirePlumber is required for process-scoped Linux audio: ${error.message}`);
  }
  return parseWirePlumberVersion(output);
}

function normalizeFamily(wirePlumberVersion, run) {
  if (wirePlumberVersion === "0.4" || wirePlumberVersion === "0.5") {
    return { family: wirePlumberVersion, version: wirePlumberVersion };
  }
  if (wirePlumberVersion) return parseWirePlumberVersion(wirePlumberVersion);
  return detectWirePlumber({ run });
}

function policyFiles({
  routes = DEFAULT_ROUTES,
  environment = process.env,
  wirePlumberVersion,
  run = execFileSync,
  readFile = fs.readFileSync,
  assetRoot,
} = {}) {
  const detected = normalizeFamily(wirePlumberVersion, run);
  const resolvedAssetRoot = assetRoot ?? resolvePolicyAssetRoot();
  const files = [{ path: policyPath(environment), contents: renderPipeWireConfig(routes) }];
  if (detected.family === "0.4") {
    files.push({
      path: familyPolicyPaths(environment, "0.4")[0],
      contents: renderWirePlumber04Config(routes),
    }, {
      path: familyPolicyPaths(environment, "0.4")[1],
      contents: `-- Managed by ChatGPT Persona Voice; policy-version=${POLICY_VERSION}\n${readFile(path.join(resolvedAssetRoot, "0.4", "cpv-create-item.lua"), "utf8")}`,
    });
  } else {
    files.push({
      path: familyPolicyPaths(environment, "0.5")[0],
      contents: renderWirePlumber05Config(routes),
    }, {
      path: familyPolicyPaths(environment, "0.5")[1],
      contents: `-- Managed by ChatGPT Persona Voice; policy-version=${POLICY_VERSION}\n${readFile(path.join(resolvedAssetRoot, "0.5", "cpv-policy.lua"), "utf8")}`,
    });
  }
  return { ...detected, files };
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function manifestHash(files) {
  return sha256(files.map((file) => `${file.path}\0${sha256(file.contents)}\n`).join(""));
}

function readOptional(destination, readFile = fs.readFileSync) {
  try { return readFile(destination, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isManaged(contents) {
  return typeof contents === "string" && MANAGED_PATTERN.test(contents);
}

function atomicWrite(destination, contents) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function replaceTransaction(files) {
  const previous = new Map();
  for (const file of files) {
    const existing = readOptional(file.path);
    if (existing !== null && !isManaged(existing)) {
      throw new Error(`Refusing to replace an unmanaged Linux audio policy file at ${file.path}`);
    }
    previous.set(file.path, existing);
  }
  const committed = [];
  try {
    for (const file of files) {
      atomicWrite(file.path, file.contents);
      committed.push(file.path);
    }
  } catch (error) {
    for (const destination of committed.reverse()) {
      const contents = previous.get(destination);
      if (contents === null) fs.rmSync(destination, { force: true });
      else atomicWrite(destination, contents);
    }
    throw error;
  }
}

function removeTransaction(files) {
  const staged = [];
  for (const file of files) {
    const contents = readOptional(file.path);
    if (contents !== null && !isManaged(contents)) {
      throw new Error(`Refusing to remove an unmanaged Linux audio policy file at ${file.path}`);
    }
  }
  try {
    for (const file of files) {
      if (readOptional(file.path) === null) continue;
      const temporary = `${file.path}.remove-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      fs.renameSync(file.path, temporary);
      staged.push({ original: file.path, temporary });
    }
    for (const entry of staged) fs.rmSync(entry.temporary, { force: true });
  } catch (error) {
    for (const entry of staged.reverse()) {
      if (fs.existsSync(entry.temporary)) fs.renameSync(entry.temporary, entry.original);
    }
    throw error;
  }
  return staged.length;
}

function managedFilesAtPaths(destinations) {
  return destinations.flatMap((destination) => {
    const contents = readOptional(destination);
    return isManaged(contents) ? [{ path: destination }] : [];
  });
}

function restartAudioSession({ run = execFileSync } = {}) {
  run("systemctl", ["--user", "restart", "pipewire.service", "pipewire-pulse.service", "wireplumber.service"], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readActivationReceipt(environment, readFile = fs.readFileSync) {
  const raw = readOptional(activationPath(environment), readFile);
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function inspectPolicy(options = {}) {
  const specification = policyFiles(options);
  const records = specification.files.map((file) => {
    const existing = readOptional(file.path, options.readFile);
    return {
      path: file.path,
      exists: existing !== null,
      managed: isManaged(existing),
      current: existing === file.contents,
      sha256: existing === null ? null : sha256(existing),
    };
  });
  const installed = records.every((record) => record.current);
  const conflict = records.some((record) => record.exists && !record.managed);
  const expectedManifest = manifestHash(specification.files);
  const receipt = readActivationReceipt(options.environment ?? process.env, options.readFile);
  const reloadRequired = !installed || receipt?.manifest !== expectedManifest || receipt?.family !== specification.family;
  return {
    family: specification.family,
    wirePlumberVersion: specification.version,
    policyVersion: POLICY_VERSION,
    installed,
    conflict,
    reloadRequired,
    runtimeProbeRequired: true,
    manifest: expectedManifest,
    files: records,
  };
}

function writeActivationReceipt(environment, result) {
  atomicWrite(activationPath(environment), `${JSON.stringify({
    policyVersion: POLICY_VERSION,
    family: result.family,
    manifest: result.manifest,
    reloadedAt: new Date().toISOString(),
  })}\n`);
}

function installPolicy(options = {}) {
  const environment = options.environment ?? process.env;
  const before = inspectPolicy(options);
  if (before.conflict) throw new Error("Refusing to replace unmanaged Linux audio policy files");
  const specification = policyFiles(options);
  replaceTransaction(specification.files);
  const installedPaths = new Set(specification.files.map((file) => file.path));
  const staleManagedFiles = managedFilesAtPaths(
      allPolicyPaths(environment).filter((destination) => !installedPaths.has(destination)));
  if (staleManagedFiles.length > 0) removeTransaction(staleManagedFiles);
  let result = inspectPolicy(options);
  if (options.reload) {
    restartAudioSession({ run: options.run });
    writeActivationReceipt(environment, result);
    result = inspectPolicy(options);
  }
  return { ...result, reloaded: Boolean(options.reload) };
}

function removePolicy(options = {}) {
  const environment = options.environment ?? process.env;
  const before = inspectPolicy(options);
  if (before.conflict) throw new Error("Refusing to remove unmanaged Linux audio policy files");
  const specification = policyFiles(options);
  const managedFiles = managedFilesAtPaths(allPolicyPaths(environment));
  const removedFiles = removeTransaction(managedFiles);
  if (options.reload && removedFiles > 0) restartAudioSession({ run: options.run });
  fs.rmSync(activationPath(environment), { force: true });
  return {
    family: specification.family,
    removed: removedFiles > 0,
    removedFiles,
    reloadRequired: removedFiles > 0 && !options.reload,
    reloaded: Boolean(options.reload && removedFiles > 0),
  };
}

module.exports = {
  ASSET_ROOT,
  DEFAULT_ROUTES,
  NODE_PREFIX,
  POLICY_VERSION,
  activationPath,
  allPolicyPaths,
  detectWirePlumber,
  inspectPolicy,
  installPolicy,
  normalizeIdentities,
  normalizeRoutes,
  parseWirePlumberVersion,
  policyFiles,
  policyPath,
  removePolicy,
  renderPipeWireConfig,
  renderWirePlumber04Config,
  renderWirePlumber05Config,
  resolvePolicyAssetRoot,
  routeNode,
  restartAudioSession,
};
