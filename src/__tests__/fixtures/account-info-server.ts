// Isolated child-process fixture: fake credentials, temporary HOME, no upstream I/O.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../../proxy/server.js";

let profiles = 0;
globalThis.fetch = async input => {
  const url = String(input);
  if (url === "https://api.anthropic.com/api/oauth/profile") {
    profiles++;
    return Response.json({
      account: { uuid: "fixture-user", email: "fixture@example.com" },
      organization: {
        uuid: "fixture-org", name: `Workspace ${profiles}`, organization_type: "claude_team",
        subscription_status: "active", subscription_created_at: "2025-01-01T00:00:00Z",
      },
    });
  }
  if (url.startsWith("https://api.anthropic.com/api/oauth/usage")) return Response.json({});
  throw new Error("Unexpected upstream request in isolated metadata fixture");
};

const listen = express.application.listen;
express.application.listen = function (...args: Parameters<typeof listen>) {
  const server = listen.apply(this, args) as Server;
  server.once("listening", () => process.send?.({ port: (server.address() as AddressInfo).port }));
  return server;
} as typeof listen;

await startServer({ port: 0, accountsPath: process.env.ACCOUNTS_PATH });
