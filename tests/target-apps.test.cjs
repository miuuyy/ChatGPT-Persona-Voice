"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  requireTargetApp,
  targetAppLabel,
  targetAppLinuxRouteIds,
  targetAppProcessPattern,
} = require("../electron/target-apps.cjs");

test("target applications expose distinct process and Linux route identities", () => {
  assert.equal(targetAppLabel("chatgpt"), "ChatGPT");
  assert.equal(targetAppLabel("grok-bot"), "Grok Bot");
  assert.deepEqual(targetAppLinuxRouteIds("chatgpt"), ["chatgpt", "codex"]);
  assert.deepEqual(targetAppLinuxRouteIds("grok-bot"), ["grok-bot"]);
  assert.match("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", targetAppProcessPattern("chatgpt"));
  assert.doesNotMatch("/Applications/ChatGPT.app/Contents/Resources/codex", targetAppProcessPattern("chatgpt"));
  assert.match("/Applications/Grok Bot.app/Contents/MacOS/Grok Bot", targetAppProcessPattern("grok-bot"));
  assert.match("C:\\Program Files\\Grok Bot\\Grok Bot.exe", targetAppProcessPattern("grok-bot"));
  assert.throws(() => requireTargetApp("other"), /Unknown target application/);
});
