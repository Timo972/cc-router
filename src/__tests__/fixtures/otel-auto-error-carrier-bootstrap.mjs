import { register } from "node:module";
import { isIP } from "node:net";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function literalLoopbackUrl(name, expectedPath) {
  const url = new URL(requiredEnvironment(name));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:"
    || (hostname !== "::1" && !(isIP(hostname) === 4 && hostname.startsWith("127.")))
    || url.pathname !== expectedPath
    || url.search !== "") {
    throw new Error(`${name} must be exact literal-loopback ${expectedPath}`);
  }
  return url;
}

literalLoopbackUrl("CC_ROUTER_TEST_OTLP_TRACE_URL", "/i/v1/traces");
literalLoopbackUrl("CC_ROUTER_TEST_OTLP_LOG_URL", "/i/v1/logs");
const postHogOrigin = literalLoopbackUrl("CC_ROUTER_TEST_POSTHOG_ORIGIN", "/");
const realFetch = globalThis.fetch;
const blocked = [];
const redirected = [];
let resolvePostHog;
const postHogCaptured = new Promise(resolve => { resolvePostHog = resolve; });
globalThis.__ccRouterTestNetworkGuard = { blocked, redirected, postHogCaptured };
globalThis.fetch = async (input, init) => {
  const original = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const hostname = original.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."))) {
    return realFetch(input, init);
  }
  const requestKey = `${method} ${original.origin}${original.pathname}${original.search}`;
  if (requestKey === "POST https://eu.i.posthog.com/batch/") {
    redirected.push(requestKey);
    const response = await realFetch(new URL("/batch/", postHogOrigin), init);
    resolvePostHog();
    return response;
  }
  blocked.push(requestKey);
  throw new Error(`external fetch blocked before socket creation: ${requestKey}`);
};

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
await import("./otel-auto-error-carrier.mjs");
