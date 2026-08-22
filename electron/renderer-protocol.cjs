"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const RENDERER_SCHEME = "persona";
const RENDERER_HOST = "app";
const PACKAGED_RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

function registerRendererScheme(protocol) {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== "function") {
    throw new TypeError("Electron protocol registration is required");
  }
  protocol.registerSchemesAsPrivileged([{
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  }]);
}

function resolveRendererAsset(rendererRoot, requestUrl) {
  if (!path.isAbsolute(rendererRoot)) throw new TypeError("Renderer root must be absolute");
  const origin = `${RENDERER_SCHEME}://${RENDERER_HOST}`;
  if (typeof requestUrl !== "string" || !requestUrl.startsWith(`${origin}/`)) return null;
  const rawPath = requestUrl.slice(origin.length).split(/[?#]/, 1)[0];
  let rawDecodedPath;
  try { rawDecodedPath = decodeURIComponent(rawPath); }
  catch { return null; }
  if (rawDecodedPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  let target;
  try { target = new URL(requestUrl); }
  catch { return null; }
  if (
    target.protocol !== `${RENDERER_SCHEME}:` ||
    target.hostname !== RENDERER_HOST ||
    target.username !== "" ||
    target.password !== "" ||
    target.port !== ""
  ) return null;

  const decodedPath = rawDecodedPath;
  if (decodedPath.includes("\0") || decodedPath.includes("\\") || decodedPath.includes(":")) return null;

  const relativeAsset = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  if (!relativeAsset) return null;
  const assetPath = path.resolve(rendererRoot, relativeAsset);
  const relativePath = path.relative(rendererRoot, assetPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return assetPath;
}

function createRendererProtocolHandler({ net, rendererRoot }) {
  if (!net || typeof net.fetch !== "function") throw new TypeError("Electron net.fetch is required");
  if (!path.isAbsolute(rendererRoot)) throw new TypeError("Renderer root must be absolute");
  return (request) => {
    if (!request || (request.method !== "GET" && request.method !== "HEAD")) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const assetPath = resolveRendererAsset(rendererRoot, request.url);
    if (!assetPath) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return net.fetch(pathToFileURL(assetPath).href, { method: request.method });
  };
}

function installRendererProtocol({ protocol, net, rendererRoot }) {
  if (!protocol || typeof protocol.handle !== "function" || typeof protocol.isProtocolHandled !== "function") {
    throw new TypeError("Electron protocol handler is required");
  }
  if (protocol.isProtocolHandled(RENDERER_SCHEME)) {
    throw new Error(`${RENDERER_SCHEME}: protocol is already handled`);
  }
  protocol.handle(RENDERER_SCHEME, createRendererProtocolHandler({ net, rendererRoot }));
}

module.exports = {
  PACKAGED_RENDERER_URL,
  RENDERER_HOST,
  RENDERER_SCHEME,
  createRendererProtocolHandler,
  installRendererProtocol,
  registerRendererScheme,
  resolveRendererAsset,
};
