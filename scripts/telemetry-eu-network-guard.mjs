import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";

const guardMode = process.env.CC_ROUTER_EU_GUARD_MODE;
const offlineTest = guardMode === "offline-test" && process.env.NODE_ENV === "test";
if (guardMode !== "validation" && !offlineTest) {
  throw new Error("telemetry EU network guard requires CC_ROUTER_EU_GUARD_MODE=validation");
}

const providerOrigin = new URL(process.env.CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN ?? "http://127.0.0.1:1");
const offlineCaptureOrigin = offlineTest
  ? new URL(process.env.CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN ?? "http://127.0.0.1:1")
  : undefined;
const networkLog = process.env.CC_ROUTER_EU_NETWORK_LOG;
const approvedPostHogPaths = new Set(["/batch/", "/i/v1/traces", "/i/v1/logs"]);

function record(kind, url) {
  if (!networkLog) return;
  appendFileSync(networkLog, `${JSON.stringify({ kind, protocol: url.protocol, hostname: url.hostname, path: url.pathname })}\n`);
}

function literalLoopback(hostname) {
  const normalized = String(hostname ?? "").replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return normalized === "::1";
}

function approvedUrl(url) {
  if (url.protocol === "https:"
    && url.hostname === "eu.i.posthog.com"
    && approvedPostHogPaths.has(url.pathname)) return true;
  return url.protocol === "http:" && literalLoopback(url.hostname);
}

if (offlineCaptureOrigin
  && (offlineCaptureOrigin.protocol !== "http:" || !literalLoopback(offlineCaptureOrigin.hostname))) {
  throw new Error("offline capture origin must be a literal-loopback HTTP URL");
}

function requestUrl(args, protocol) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return new URL(first);
  const options = first ?? {};
  const hostname = options.hostname ?? options.host;
  const port = options.port ? `:${String(options.port)}` : "";
  const path = options.path ?? "/";
  return new URL(`${protocol}//${String(hostname)}${port}${String(path)}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
    const redirected = new URL(`${url.pathname}${url.search}`, providerOrigin);
    record("provider-loopback", redirected);
    return originalFetch(redirected, init);
  }
  if (offlineCaptureOrigin
    && url.protocol === "https:"
    && url.hostname === "eu.i.posthog.com"
    && approvedPostHogPaths.has(url.pathname)) {
    const redirected = new URL(`${url.pathname}${url.search}`, offlineCaptureOrigin);
    record("offline-posthog-loopback", redirected);
    return originalFetch(redirected, init);
  }
  if (!approvedUrl(url)) throw new Error(`blocked external fetch: ${url.protocol}//${url.hostname}${url.pathname}`);
  record("fetch", url);
  return originalFetch(input, init);
};

function guardRequest(original, protocol) {
  return function guardedRequest(...args) {
    const url = requestUrl(args, protocol);
    if (!approvedUrl(url)) throw new Error(`blocked external request: ${url.protocol}//${url.hostname}${url.pathname}`);
    record("request", url);
    return Reflect.apply(original, this, args);
  };
}

http.request = guardRequest(http.request, "http:");
https.request = guardRequest(https.request, "https:");

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  const candidate = Array.isArray(first) ? first[0] : first;
  const options = typeof candidate === "object" && candidate !== null ? candidate : undefined;
  const hostname = options?.host ?? options?.hostname ?? (typeof args[1] === "string" ? args[1] : undefined);
  if (!literalLoopback(hostname) && hostname !== "eu.i.posthog.com") {
    throw new Error(`blocked external socket: ${String(hostname ?? "unknown")}`);
  }
  return Reflect.apply(originalConnect, this, args);
};
