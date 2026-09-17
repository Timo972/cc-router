// Full-server acceptance fixture: temporary credentials/home; zero external requests.
import express from "express";
import http from "node:http";
import https from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../../proxy/server.js";
// http-proxy uses node:http(s), not global fetch. Guard that path too.
http.request = (() => { throw new Error("Unexpected HTTP egress in usage fixture"); }) as typeof http.request;
https.request = (() => { throw new Error("Unexpected HTTPS egress in usage fixture"); }) as typeof https.request;
let requests = 0;
globalThis.fetch = async input => {
  const url = String(input);
  if (url === "https://chatgpt.com/backend-api/codex/responses") {
    requests++;
    const response = { id: `fixture-${requests}`, object: "response", status: "completed", model: "gpt-5.4", output: [],
      usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 } } };
    return new Response(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: response.id, model: response.model } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  if (url.includes("wham/usage")) return Response.json({ account_id: "fixture-workspace", user_id: "fixture-user", email: "private-fixture@example.com", plan_type: "plus" });
  if (url.includes("wham/accounts/check")) return Response.json({ accounts: [{ id: "fixture-workspace", name: "Private workspace", structure: "personal", plan_type: "plus" }] });
  if (url.includes("/models")) return Response.json({ models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }] });
  throw new Error("Unexpected upstream URL in isolated usage fixture");
};
const listen = express.application.listen;
express.application.listen = function (this: express.Application, ...args: Parameters<typeof listen>) {
  const server = listen.apply(this, args) as Server;
  server.once("listening", () => process.send?.({ port: (server.address() as AddressInfo).port }));
  return server;
} as typeof listen;
await startServer({ port: Number(process.env.USAGE_FIXTURE_PORT ?? 0), accountsPath: process.env.ACCOUNTS_PATH });
