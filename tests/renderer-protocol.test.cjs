"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const {
  PACKAGED_RENDERER_URL,
  RENDERER_SCHEME,
  createRendererProtocolHandler,
  installRendererProtocol,
  registerRendererScheme,
  resolveRendererAsset,
} = require("../electron/renderer-protocol.cjs");

test("renderer scheme is standard and secure without privileged file pages", () => {
  let registration = null;
  registerRendererScheme({ registerSchemesAsPrivileged(value) { registration = value; } });
  assert.deepEqual(registration, [{
    scheme: "persona",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  }]);
  assert.equal(PACKAGED_RENDERER_URL, "persona://app/index.html");
});

test("renderer resolver confines decoded paths to the packaged dist root", () => {
  const rendererRoot = path.join(os.tmpdir(), "persona-renderer-root");
  assert.equal(
    resolveRendererAsset(rendererRoot, PACKAGED_RENDERER_URL),
    path.join(rendererRoot, "index.html"),
  );
  assert.equal(
    resolveRendererAsset(rendererRoot, "persona://app/assets/index-AbC_12.js"),
    path.join(rendererRoot, "assets", "index-AbC_12.js"),
  );
  for (const rejected of [
    "persona://other/index.html",
    "persona://app/%2e%2e/secret.txt",
    "persona://app/assets/%2e%2e/%2e%2e/secret.txt",
    "persona://app/assets/%5c..%5csecret.txt",
    "persona://app/C%3A/secret.txt",
    "file:///etc/passwd",
    "not a URL",
  ]) assert.equal(resolveRendererAsset(rendererRoot, rejected), null, rejected);
});

test("renderer handler serves only GET and HEAD assets through Electron net", async () => {
  const rendererRoot = path.join(os.tmpdir(), "persona-renderer-root");
  const requests = [];
  const handler = createRendererProtocolHandler({
    rendererRoot,
    net: {
      fetch(url, init) {
        requests.push({ url, init });
        return Promise.resolve(new Response("asset", { status: 200 }));
      },
    },
  });
  assert.equal((await handler({ method: "GET", url: PACKAGED_RENDERER_URL })).status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, pathToFileURL(path.join(rendererRoot, "index.html")).href);
  assert.deepEqual(requests[0].init, { method: "GET" });
  assert.equal((await handler({ method: "POST", url: PACKAGED_RENDERER_URL })).status, 405);
  assert.equal((await handler({ method: "GET", url: "persona://other/index.html" })).status, 404);
  assert.equal(requests.length, 1);
});

test("renderer protocol install fails closed on duplicate ownership", () => {
  let handled = null;
  installRendererProtocol({
    rendererRoot: path.join(os.tmpdir(), "persona-renderer-root"),
    net: { fetch: async () => new Response("asset") },
    protocol: {
      isProtocolHandled: () => false,
      handle(scheme, handler) { handled = { scheme, handler }; },
    },
  });
  assert.equal(handled.scheme, RENDERER_SCHEME);
  assert.equal(typeof handled.handler, "function");
  assert.throws(() => installRendererProtocol({
    rendererRoot: path.join(os.tmpdir(), "persona-renderer-root"),
    net: { fetch: async () => new Response("asset") },
    protocol: {
      isProtocolHandled: () => true,
      handle() { throw new Error("must not install"); },
    },
  }), /already handled/);
});
