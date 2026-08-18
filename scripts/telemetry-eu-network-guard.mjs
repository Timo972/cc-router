import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net, { isIP } from "node:net";

const guardMode = process.env.CC_ROUTER_EU_GUARD_MODE;
const offlineTest = guardMode === "offline-test" && process.env.NODE_ENV === "test";
if (guardMode !== "validation" && !offlineTest) {
  throw new Error("telemetry EU network guard requires CC_ROUTER_EU_GUARD_MODE=validation");
}

function explicitLoopbackOrigin(value, label) {
  if (!value) throw new Error(`${label} must be supplied`);
  const url = new URL(value);
  if (url.protocol !== "http:"
    || !literalLoopback(url.hostname)
    || url.port === ""
    || url.pathname !== "/"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== "") {
    throw new Error(`${label} must be an explicit literal-loopback HTTP origin`);
  }
  return url;
}

const providerOrigin = explicitLoopbackOrigin(
  process.env.CC_ROUTER_EU_LOOPBACK_PROVIDER_ORIGIN,
  "provider origin",
);
const offlineCaptureOrigin = offlineTest
  ? explicitLoopbackOrigin(process.env.CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN, "offline capture origin")
  : undefined;
const networkLog = process.env.CC_ROUTER_EU_NETWORK_LOG;
const approvedPostHogPaths = new Set(["/batch/", "/i/v1/traces", "/i/v1/logs"]);

function record(kind, target, method) {
  if (!networkLog) return;
  appendFileSync(networkLog, `${JSON.stringify({
    kind,
    protocol: target.protocol,
    hostname: target.hostname,
    ...(target.port ? { port: String(target.port) } : {}),
    ...(method ? { method } : {}),
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

function exactOriginTarget(target, origin, method, paths) {
  return target.protocol === origin.protocol
    && target.hostname === origin.hostname
    && String(target.port) === String(origin.port)
    && method === "POST"
    && paths.has(target.pathname);
}

function approvedTarget(target, method) {
  if (approvedPostHogTarget(target, method)) return true;
  if (exactOriginTarget(target, providerOrigin, method, new Set(["/backend-api/codex/responses"]))) return true;
  return offlineCaptureOrigin !== undefined
    && exactOriginTarget(target, offlineCaptureOrigin, method, approvedPostHogPaths);
}

const socketAuthorization = new AsyncLocalStorage();

function effectivePort(target) {
  if (target.port) return String(target.port);
  if (target.protocol === "https:") return "443";
  if (target.protocol === "http:") return "80";
  return "";
}

function withAuthorizedSocket(target, method, operation) {
  return socketAuthorization.run({
    hostname: target.hostname,
    port: effectivePort(target),
    method,
    path: target.pathname,
    socket: undefined,
    acceptedSockets: 0,
  }, operation);
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
  if (method === "POST" && url.protocol === "https:" && url.hostname === "chatgpt.com"
    && url.pathname === "/backend-api/codex/responses") {
    const redirected = new URL(`${url.pathname}${url.search}`, providerOrigin);
    const target = targetFromUrl(redirected);
    record("provider-loopback", target, method);
    return withAuthorizedSocket(target, method, () => originalFetch(redirected, init));
  }
  const target = targetFromUrl(url);
  if (offlineCaptureOrigin && approvedPostHogTarget(target, method)) {
    const redirected = new URL(`${url.pathname}${url.search}`, offlineCaptureOrigin);
    const redirectedTarget = targetFromUrl(redirected);
    record("offline-posthog-loopback", redirectedTarget, method);
    return withAuthorizedSocket(redirectedTarget, method, () => originalFetch(redirected, init));
  }
  if (!approvedTarget(target, method)) {
    record("blocked-fetch", target, method);
    throw new Error(`blocked external fetch: ${url.protocol}//${url.hostname}${url.pathname}`);
  }
  record("fetch", target, method);
  return withAuthorizedSocket(target, method, () => originalFetch(input, init));
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
      const redirectedTarget = targetFromUrl(redirected);
      record("offline-posthog-loopback", redirectedTarget, method);
      const first = args[0];
      if (typeof first === "string" || first instanceof URL) {
        return withAuthorizedSocket(redirectedTarget, method, () => (
          Reflect.apply(originalHttpRequest, http, [redirected, ...args.slice(1)])
        ));
      }
      const options = first ?? {};
      return withAuthorizedSocket(redirectedTarget, method, () => (
        Reflect.apply(originalHttpRequest, http, [{
          ...options,
          protocol: redirected.protocol,
          hostname: redirected.hostname,
          host: redirected.host,
          port: redirected.port,
          path: `${redirected.pathname}${redirected.search}`,
        }, ...args.slice(1)])
      ));
    }
    if (!approvedTarget(target, method)) {
      record("blocked-request", target, method);
      throw new Error(`blocked external request: ${target.protocol}//${target.hostname}${target.pathname}`);
    }
    record("request", target, method);
    return withAuthorizedSocket(target, method, () => Reflect.apply(original, this, args));
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
  const authorization = socketAuthorization.getStore();
  const normalizedHostname = String(hostname ?? "").replace(/^\[|\]$/g, "");
  const previousSocketIsClosed = authorization?.socket?.destroyed === true;
  if (!authorization
    || authorization.acceptedSockets >= 2
    || (authorization.socket !== undefined && !previousSocketIsClosed)
    || authorization.hostname !== normalizedHostname
    || authorization.port !== String(port)) {
    record("blocked-socket", {
      protocol: "tcp:",
      hostname: normalizedHostname || "unknown",
      port,
      pathname: "",
    });
    throw new Error(`blocked external socket: ${String(hostname ?? "unknown")}`);
  }
  // Undici can replace a destroyed transport while settling one authorized
  // request. Permit at most that one sequential replacement in the same async
  // request context; further, live, other-target, or provenance-free sockets fail.
  authorization.socket = this;
  authorization.acceptedSockets += 1;
  record("approved-socket", {
    protocol: "tcp:",
    hostname: normalizedHostname,
    port,
    pathname: authorization.path,
  }, authorization.method);
  return Reflect.apply(originalConnect, this, args);
};

syncBuiltinESMExports();
