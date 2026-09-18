"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectPolicy,
  installPolicy,
  parseWirePlumberVersion,
  policyPath,
  removePolicy,
  renderPipeWireConfig,
  renderWirePlumber04Config,
  renderWirePlumber05Config,
  routeNode,
} = require("../electron/linux-audio-policy.cjs");

function temporaryPolicyEnvironment(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
  };
}

test("Linux policy separates ChatGPT, Codex, and Grok Bot before physical target selection", () => {
  const pipewire = renderPipeWireConfig();
  const wireplumber04 = renderWirePlumber04Config();
  const wireplumber05 = renderWirePlumber05Config();
  for (const routeId of ["chatgpt", "codex", "grok-bot"]) {
    assert.match(pipewire, new RegExp(routeNode("ingress", routeId).replaceAll(".", "\\.")));
    assert.match(pipewire, new RegExp(routeNode("bypass", routeId).replaceAll(".", "\\.")));
    assert.match(wireplumber04, new RegExp(`route = "${routeId}"`));
    assert.match(wireplumber05, new RegExp(`route = "${routeId}"`));
  }
  assert.equal((pipewire.match(/libpipewire-module-loopback/g) || []).length, 3);
  assert.doesNotMatch(pipewire, /node\.rules|target\.object/);
  assert.match(wireplumber04, /load_script\("cpv-create-item\.lua"/);
  assert.match(wireplumber05, /hooks\.cpv\.policy = required/);
});

test("Linux policy lifecycle installs owned files and persists one-time reload proof", () => {
  const { root, environment } = temporaryPolicyEnvironment("cpv-policy-");
  const options = { environment, wirePlumberVersion: "0.4" };
  const calls = [];
  try {
    assert.equal(inspectPolicy(options).installed, false);
    const installed = installPolicy(options);
    assert.equal(installed.installed, true);
    assert.equal(installed.reloadRequired, true);
    assert.equal(installed.files.length, 3);
    if (process.platform !== "win32") {
      for (const file of installed.files) assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
    }

    const activated = installPolicy({
      ...options,
      reload: true,
      run: (command, args) => calls.push({ command, args }),
    });
    assert.equal(activated.reloadRequired, false);
    assert.equal(inspectPolicy(options).reloadRequired, false);
    assert.deepEqual(calls, [{
      command: "systemctl",
      args: ["--user", "restart", "pipewire.service", "pipewire-pulse.service", "wireplumber.service"],
    }]);

    const removed = removePolicy(options);
    assert.equal(removed.removedFiles, 3);
    assert.equal(removed.reloadRequired, true);
    assert.equal(inspectPolicy(options).installed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux policy refuses unmanaged conflicts and relative XDG roots", () => {
  const { root, environment } = temporaryPolicyEnvironment("cpv-policy-conflict-");
  const options = { environment, wirePlumberVersion: "0.4" };
  try {
    const destination = policyPath(environment);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "user-owned=true\n");
    assert.equal(inspectPolicy(options).conflict, true);
    assert.throws(() => installPolicy(options), /unmanaged/i);
    assert.throws(() => removePolicy(options), /unmanaged/i);
    assert.equal(fs.readFileSync(destination, "utf8"), "user-owned=true\n");
    assert.throws(() => inspectPolicy({
      environment: { HOME: root, XDG_CONFIG_HOME: "relative" },
      wirePlumberVersion: "0.4",
    }), /absolute path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux policy supports only audited WirePlumber policy families", () => {
  assert.deepEqual(parseWirePlumberVersion("Linked with libwireplumber 0.4.17"), {
    family: "0.4", version: "0.4.17",
  });
  assert.deepEqual(parseWirePlumberVersion("wireplumber 0.5.8"), {
    family: "0.5", version: "0.5.8",
  });
  assert.throws(() => parseWirePlumberVersion("wireplumber 0.6.0"), /not supported/);
});
