import https from "node:https";
import { get as namedGet, request as namedRequest } from "node:https";
import { sendApprovedNamedImportsLoadedBeforeGuard } from "./network-named-import-before-preload.mjs";

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

await send(https.request, {
  hostname: "eu.i.posthog.com",
  method: "POST",
  path: "/batch/",
}, false);
await send(https.get, {
  hostname: "eu.i.posthog.com",
  method: "POST",
  path: "/i/v1/logs",
}, true);
await sendApprovedNamedImportsLoadedBeforeGuard();
await send(namedRequest, {
  hostname: "eu.i.posthog.com",
  method: "POST",
  path: "/i/v1/logs",
}, false);
await send(namedGet, {
  hostname: "eu.i.posthog.com",
  method: "POST",
  path: "/i/v1/traces",
}, true);
