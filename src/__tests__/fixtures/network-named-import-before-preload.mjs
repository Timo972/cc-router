import { get as httpGet, request as httpRequest } from "node:http";
import { get as httpsGet, request as httpsRequest } from "node:https";

function caught(operation) {
  try { operation(); } catch {}
}

export function attemptBlockedNamedImportsLoadedBeforeGuard() {
  caught(() => httpRequest("http://example.invalid/named-before-http-request"));
  caught(() => httpGet("http://example.invalid/named-before-http-get"));
  caught(() => httpsRequest({
    hostname: "eu.i.posthog.com",
    method: "POST",
    path: "/named-before-not-approved",
  }));
  caught(() => httpsGet({
    hostname: "eu.i.posthog.com",
    method: "POST",
    path: "/batch/",
    port: 8443,
  }));
}

function send(operation, options, endsItself) {
  return new Promise((resolve, reject) => {
    const request = operation(options, response => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
    if (!endsItself) request.end();
  });
}

export async function sendApprovedNamedImportsLoadedBeforeGuard() {
  await send(httpsRequest, {
    hostname: "eu.i.posthog.com",
    method: "POST",
    path: "/i/v1/traces",
  }, false);
  await send(httpsGet, {
    hostname: "eu.i.posthog.com",
    method: "POST",
    path: "/batch/",
  }, true);
}
