"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  defaultVoiceProcessTree,
  parseMacProcesses,
  parseWindowsProcesses,
  pipeWireSources,
  processSourceId,
  processSources,
  selectedProcessTree,
} = require("../electron/source-discovery.cjs");
const { targetAppProcessPattern } = require("../electron/target-apps.cjs");

test("platform parsers preserve process identity and expose only audio-output sources", () => {
  const macProcesses = parseMacProcesses(
    "  12     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n  20    12 helper process\n",
  );
  assert.deepEqual(macProcesses[0], {
    pid: 12,
    parentId: 1,
    executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  });
  assert.equal(macProcesses[1].executable, "helper process");

  const windowsProcesses = parseWindowsProcesses(
    JSON.stringify({
      ProcessId: 42,
      ParentProcessId: 1,
      Name: "ChatGPT.exe",
      ExecutablePath: "C:\\Apps\\ChatGPT.exe",
    }),
  );
  assert.equal(windowsProcesses.length, 1);
  assert.equal(windowsProcesses[0].pid, 42);

  const pipeWire = pipeWireSources([
    {
      id: 1,
      type: "PipeWire:Interface:Client",
      info: {
        props: {
          "application.name": "ChatGPT",
          "application.process.binary": "chatgpt",
        },
      },
    },
    {
      id: 2,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "client.id": 1,
          "media.class": "Stream/Output/Audio",
          "node.name": "chatgpt-output",
        },
      },
    },
    {
      id: 3,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "client.id": 1,
          "media.class": "Stream/Input/Audio",
          "node.name": "microphone",
        },
      },
    },
  ]);
  assert.equal(pipeWire.length, 1);
  assert.equal(pipeWire[0].name, "ChatGPT");
  assert.match(pipeWire[0].id, /^pipewire:stream:/);
});

test("explicit process discovery resolves descendants while cutting out Persona's complete branch", () => {
  const sources = processSources(
    [
      { pid: 100, parentId: 1, executable: "/app/launcher" },
      { pid: 101, parentId: 100, executable: "/app/helper" },
      { pid: 200, parentId: 1, executable: "/Applications/ChatGPT" },
      { pid: 201, parentId: 200, executable: "/Applications/ChatGPT" },
    ],
    "darwin",
    100,
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, "ChatGPT");

  const descendantProcesses = [
    { pid: 10, parentId: 1, executable: "/Applications/ChatGPT" },
    { pid: 11, parentId: 10, executable: "/Applications/ChatGPT Helper" },
    { pid: 12, parentId: 11, executable: "/Applications/ChatGPT Audio" },
    { pid: 20, parentId: 1, executable: "/Applications/Other" },
  ];
  const descendantSourceId = processSourceId(descendantProcesses[0], "darwin");
  assert.deepEqual(
    selectedProcessTree(descendantProcesses, "darwin", descendantSourceId, 999),
    {
      pids: [10, 11, 12],
      rootPids: [10],
    },
  );
  assert.deepEqual(
    selectedProcessTree(
      descendantProcesses,
      "darwin",
      "process:darwin:bWlzc2luZw",
      999,
    ),
    {
      pids: [],
      rootPids: [],
    },
  );

  const ownedBranchProcesses = [
    {
      pid: 653,
      parentId: 1,
      name: "ChatGPT",
      executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    {
      pid: 700,
      parentId: 653,
      name: "Codex tool host",
      executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
    },
    { pid: 710, parentId: 700, name: "zsh", executable: "/bin/zsh" },
    {
      pid: 720,
      parentId: 700,
      name: "tool sibling",
      executable: "/usr/bin/tool-sibling",
    },
    {
      pid: 100,
      parentId: 710,
      name: "Electron",
      executable:
        "/projects/codex-persona-voice/node_modules/electron/Electron",
    },
    {
      pid: 101,
      parentId: 100,
      name: "Electron Helper",
      executable:
        "/projects/codex-persona-voice/node_modules/electron/Electron Helper",
    },
    {
      pid: 900,
      parentId: 653,
      name: "ChatGPT Helper",
      executable:
        "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
    },
    {
      pid: 9404,
      parentId: 653,
      name: "ChatGPT Audio",
      executable:
        "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
    },
  ];
  const expectedOwnedBranch = { pids: [653, 900, 9404], rootPids: [653] };
  assert.deepEqual(
    defaultVoiceProcessTree(ownedBranchProcesses, { ownProcessId: 100 }),
    expectedOwnedBranch,
  );
  const ownedSourceId = processSourceId(ownedBranchProcesses[0], "darwin");
  assert.deepEqual(
    selectedProcessTree(ownedBranchProcesses, "darwin", ownedSourceId, 100),
    expectedOwnedBranch,
  );
});

test("automatic discovery selects application voice trees and rejects name-only or escaped descendants", () => {
  const applicationProcesses = [
    {
      pid: 100,
      parentId: 1,
      name: "Codex Persona Voice",
      executable: "/apps/codex-persona-voice",
    },
    {
      pid: 101,
      parentId: 100,
      name: "Codex Persona Voice Helper",
      executable: "/apps/helper",
    },
    {
      pid: 200,
      parentId: 1,
      name: "ChatGPT",
      executable: "/Applications/ChatGPT",
    },
    {
      pid: 201,
      parentId: 200,
      name: "ChatGPT Helper",
      executable: "/Applications/ChatGPT Helper",
    },
    { pid: 300, parentId: 1, name: "Codex", executable: "/Applications/Codex" },
    { pid: 400, parentId: 1, name: "Other", executable: "/Applications/Other" },
  ];
  assert.deepEqual(
    defaultVoiceProcessTree(applicationProcesses, { ownProcessId: 100 }),
    {
      pids: [200, 201],
      rootPids: [200],
    },
  );

  const nameOnlyProcesses = [
    {
      pid: 10,
      parentId: 1,
      executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    {
      pid: 11,
      parentId: 10,
      executable:
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service)",
    },
    {
      pid: 20,
      parentId: 1,
      executable:
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework/Helpers/browser_crashpad_handler",
    },
    {
      pid: 30,
      parentId: 1,
      executable: "/Users/test/.codex-chatgpt-web/bin/tunnel-client",
    },
    { pid: 40, parentId: 1, executable: "/plugins/ChatGPT for Chrome" },
    {
      pid: 50,
      parentId: 1,
      executable: "/projects/codex-persona-voice/node_modules/Electron",
    },
  ];
  assert.deepEqual(
    defaultVoiceProcessTree(nameOnlyProcesses, { ownProcessId: 999 }),
    {
      pids: [10, 11],
      rootPids: [10],
    },
  );

  const escapedDescendants = [
    {
      pid: 10,
      parentId: 1,
      executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    {
      pid: 11,
      parentId: 10,
      executable:
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex (Service).app/Contents/MacOS/Codex (Service)",
    },
    { pid: 12, parentId: 10, executable: "/bin/zsh" },
    { pid: 13, parentId: 12, executable: "/Users/test/project/node" },
    {
      pid: 14,
      parentId: 10,
      executable: "/Users/test/.codex/computer-use/SkyComputerUseService",
    },
  ];
  assert.deepEqual(
    defaultVoiceProcessTree(escapedDescendants, { ownProcessId: 999 }),
    {
      pids: [10, 11],
      rootPids: [10],
    },
  );
});

test("target application discovery isolates Grok Bot from ChatGPT", () => {
  const processes = [
    {
      pid: 10,
      parentId: 1,
      executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    },
    {
      pid: 11,
      parentId: 10,
      executable: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
    },
    {
      pid: 20,
      parentId: 1,
      executable: "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot",
    },
    {
      pid: 21,
      parentId: 20,
      executable: "/Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper.app/Contents/MacOS/Grok Bot Helper",
    },
  ];
  assert.deepEqual(defaultVoiceProcessTree(processes, {
    ownProcessId: 999,
    pattern: targetAppProcessPattern("grok-bot"),
  }), {
    pids: [20, 21],
    rootPids: [20],
  });
  assert.deepEqual(defaultVoiceProcessTree(processes, {
    ownProcessId: 999,
    pattern: targetAppProcessPattern("chatgpt"),
  }), {
    pids: [10, 11],
    rootPids: [10],
  });
});
