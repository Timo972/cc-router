// Native/full-server acceptance against a real loopback upstream; all other egress blocked.
import express from "express";
import http, { type Server, type RequestOptions } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { urlToHttpOptions } from "node:url";
import type { AddressInfo } from "node:net";
import { startServer } from "../../proxy/server.js";
const backend = http.createServer((req, res) => {
  let body = ""; req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.url === "/v1/messages/count_tokens") { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":123}'); return; }
    if (req.url !== "/v1/messages") { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/event-stream");
    const start = { type: "message_start", message: { id: "fixture-message", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 } } } };
    res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
    if (body.includes('"abort"')) { setTimeout(() => res.destroy(), 30); return; }
    for (const output_tokens of [3, 8, 8]) res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens } })}\n\n`);
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});
backend.listen(0, "127.0.0.1"); await once(backend, "listening");
const upstreamPort = (backend.address() as AddressInfo).port;
const nativeRequest = http.request;
http.request = (() => { throw new Error("Unexpected HTTP egress in Anthropic fixture"); }) as typeof http.request;
https.request = ((input: string | URL | RequestOptions, second?: RequestOptions | ((res: http.IncomingMessage) => void), third?: (res: http.IncomingMessage) => void) => {
  const parsed = typeof input === "string" || input instanceof URL ? urlToHttpOptions(new URL(input)) : input;
  const options = { ...parsed, ...(typeof second === "object" ? second : {}) };
  if (options.hostname !== "api.anthropic.com" && options.host !== "api.anthropic.com") throw new Error("Unexpected HTTPS egress in Anthropic fixture");
  return nativeRequest({ ...options, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port: upstreamPort, agent: undefined }, typeof second === "function" ? second : third);
}) as typeof https.request;
syncBuiltinESMExports();
globalThis.fetch = async input => {
  const url = String(input);
  if (url === "https://api.anthropic.com/api/oauth/usage") return Response.json({});
  if (url === "https://api.anthropic.com/api/oauth/profile") return Response.json({ account: { uuid: "private-user", email: "private@example.com" }, organization: { uuid: "private-org", organization_type: "claude_max" } });
  if (url.includes("/models")) return Response.json({ data: [] });
  throw new Error("Unexpected fetch egress in Anthropic fixture");
};
const listen = express.application.listen;
express.application.listen = function (this: express.Application, ...args: Parameters<typeof listen>) {
  const server = listen.apply(this, args) as Server;
  server.once("listening", () => process.send?.({ port: (server.address() as AddressInfo).port })); return server;
} as typeof listen;
await startServer({ port: 0, accountsPath: process.env.ACCOUNTS_PATH });
