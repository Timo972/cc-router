import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
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

function record(kind, target) {
  if (!networkLog) return;
  appendFileSync(networkLog, `${JSON.stringify({
    kind,
    protocol: target.protocol,
    hostname: target.hostname,
    ...(target.port ? { port: String(target.port) } : {}),
    path: target.pathname,
  })}\n`);
}

function literalLoopback(hostname) {
  const normalized = String(hostname ?? "").replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return normalized === "::1";
}

function approvedPostHogTarget(target, method) {
  return target.protocol === "https:"
    && target.hostname === "eu.i.posthog.com"
    && (target.port === "" || String(target.port) === "443")
    && method === "POST"
    && approvedPostHogPaths.has(target.pathname);
}

function approvedTarget(target, method) {
  if (approvedPostHogTarget(target, method)) return true;
  return target.protocol === "http:" && literalLoopback(target.hostname);
}

if (offlineCaptureOrigin
  && (offlineCaptureOrigin.protocol !== "http:" || !literalLoopback(offlineCaptureOrigin.hostname))) {
  throw new Error("offline capture origin must be a literal-loopback HTTP URL");
}

function targetFromUrl(url) {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
  };
}

function splitHost(value) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end !== -1) return { hostname: raw.slice(1, end), port: raw.slice(end + 1).replace(/^:/, "") };
  }
  if (isIP(raw) !== 0) return { hostname: raw, port: "" };
  const colon = raw.lastIndexOf(":");
  return colon > 0 && raw.indexOf(":") === colon
    ? { hostname: raw.slice(0, colon), port: raw.slice(colon + 1) }
    : { hostname: raw, port: "" };
}

function requestTarget(args, protocol) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return targetFromUrl(new URL(first));
  const options = first ?? {};
  const authority = splitHost(options.hostname ?? options.host);
  const rawPath = typeof options.path === "string" ? options.path : "/";
  return {
    protocol: typeof options.protocol === "string" ? options.protocol : protocol,
    hostname: authority.hostname,
    port: options.port ? String(options.port) : authority.port,
    pathname: rawPath.startsWith("/") ? rawPath.split("?", 1)[0] : "/",
  };
}

function requestMethod(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null && !(first instanceof URL)) {
    return String(first.method ?? "GET").toUpperCase();
  }
  const options = args[1];
  return String(options?.method ?? "GET").toUpperCase();
}

function malformedTarget(protocol, args) {
  const first = args[0];
  const options = typeof first === "object" && first !== null ? first : {};
  return {
    protocol,
    hostname: splitHost(options.hostname ?? options.host).hostname || "invalid",
    port: options.port ? String(options.port) : "",
    pathname: "/",
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  } catch {
    record("blocked-fetch", {
      protocol: "invalid:",
      hostname: "invalid",
      port: "",
      pathname: "/",
    });
    throw new Error("blocked malformed external fetch");
  }
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
    const redirected = new URL(`${url.pathname}${url.search}`, providerOrigin);
    record("provider-loopback", redirected);
    return originalFetch(redirected, init);
  }
  const target = targetFromUrl(url);
  if (offlineCaptureOrigin && approvedPostHogTarget(target, method)) {
    const redirected = new URL(`${url.pathname}${url.search}`, offlineCaptureOrigin);
    record("offline-posthog-loopback", redirected);
    return originalFetch(redirected, init);
  }
  if (!approvedTarget(target, method)) {
    record("blocked-fetch", target);
    throw new Error(`blocked external fetch: ${url.protocol}//${url.hostname}${url.pathname}`);
  }
  record("fetch", url);
  return originalFetch(input, init);
};

const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

function guardRequest(original, protocol) {
  return function guardedRequest(...args) {
    let target;
    try {
      target = requestTarget(args, protocol);
    } catch {
      record("blocked-request", malformedTarget(protocol, args));
      throw new Error("blocked malformed external request");
    }
    const method = requestMethod(args);
    if (offlineCaptureOrigin && approvedPostHogTarget(target, method)) {
      const redirected = new URL(target.pathname, offlineCaptureOrigin);
      record("offline-posthog-loopback", redirected);
      const first = args[0];
      if (typeof first === "string" || first instanceof URL) {
        return Reflect.apply(originalHttpRequest, http, [redirected, ...args.slice(1)]);
      }
      const options = first ?? {};
      return Reflect.apply(originalHttpRequest, http, [{
        ...options,
        protocol: redirected.protocol,
        hostname: redirected.hostname,
        host: redirected.host,
        port: redirected.port,
        path: `${redirected.pathname}${redirected.search}`,
      }, ...args.slice(1)]);
    }
    if (!approvedTarget(target, method)) {
      record("blocked-request", target);
      throw new Error(`blocked external request: ${target.protocol}//${target.hostname}${target.pathname}`);
    }
    record("request", target);
    return Reflect.apply(original, this, args);
  };
}

const guardedHttpRequest = guardRequest(originalHttpRequest, "http:");
const guardedHttpsRequest = guardRequest(originalHttpsRequest, "https:");
http.request = guardedHttpRequest;
https.request = guardedHttpsRequest;
http.get = function guardedGet(...args) {
  const request = Reflect.apply(guardedHttpRequest, this, args);
  request.end();
  return request;
};
https.get = function guardedGet(...args) {
  const request = Reflect.apply(guardedHttpsRequest, this, args);
  request.end();
  return request;
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  const candidate = Array.isArray(first) ? first[0] : first;
  const options = typeof candidate === "object" && candidate !== null ? candidate : undefined;
  const hostname = options?.host ?? options?.hostname ?? (typeof args[1] === "string" ? args[1] : undefined);
  const port = options?.port ?? (typeof args[0] === "number" ? args[0] : "");
  const approvedPostHogSocket = hostname === "eu.i.posthog.com" && String(port) === "443";
  if (!literalLoopback(hostname) && !approvedPostHogSocket) {
    record("blocked-socket", {
      protocol: "tcp:",
      hostname: String(hostname ?? "unknown").replace(/^\[|\]$/g, ""),
      port,
      pathname: "",
    });
    throw new Error(`blocked external socket: ${String(hostname ?? "unknown")}`);
  }
  return Reflect.apply(originalConnect, this, args);
};

syncBuiltinESMExports();
