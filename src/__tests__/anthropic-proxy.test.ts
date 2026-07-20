import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProxy } from "../proxy/anthropic-proxy.js";
import { applyUpstreamFailureRouting } from "../proxy/lease-lifecycle.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function collect(url: URL): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = request(url, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function startCollecting(url: URL): {
  firstChunk: Promise<void>;
  completed: Promise<Buffer>;
  hasCompleted: () => boolean;
} {
  const first = deferred();
  let completed = false;
  const body = new Promise<Buffer>((resolve, reject) => {
    const req = request(url, response => {
      const chunks: Buffer[] = [];
      response.once("data", () => first.resolve());
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        completed = true;
        resolve(Buffer.concat(chunks));
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  return { firstChunk: first.promise, completed: body, hasCompleted: () => completed };
}

describe("createAnthropicProxy", () => {
  it("forwards deliberately split SSE bytes without inserting or removing events", async () => {
    const chunks = [
      Buffer.from("event: message_start\nda"),
      Buffer.from("ta: {\"type\":\"message_start\"}\n\n"),
      Buffer.from("event: content_block_delta\ndata: {\"delta\":{\"text\":\"hello\"}}\n\n"),
      Buffer.from("event: message_"),
      Buffer.from("stop\ndata: {\"type\":\"message_stop\"}\n\n"),
    ];
    const upstreamBody = Buffer.concat(chunks);
    const observedChunks: Buffer[] = [];
    let upstreamPath = "";
    const upstream = createServer((_req, res) => {
      upstreamPath = _req.url ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const writeNext = () => {
        if (index === chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[index++]);
        setImmediate(writeNext);
      };
      writeNext();
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 2_000,
      on: {
        proxyRes: proxyResponse => {
          proxyResponse.on("data", chunk => observedChunks.push(Buffer.from(chunk)));
        },
      },
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    try {
      const response = await collect(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(upstreamPath).toBe("/v1/messages");
      expect(Buffer.compare(response.body, upstreamBody)).toBe(0);
      expect(Buffer.compare(Buffer.concat(observedChunks), upstreamBody)).toBe(0);
      expect(response.body.toString("utf8").match(/event: message_stop/g)).toHaveLength(1);
    } finally {
      await close(downstream);
      await close(upstream);
    }
  });

  it("keeps concurrent SSE responses open until each upstream stream terminates", async () => {
    const gates = new Map([
      ["/v1/one", deferred()],
      ["/v1/two", deferred()],
    ]);
    const expected = new Map<string, Buffer>();
    const upstream = createServer(async (req, res) => {
      const path = req.url ?? "";
      const gate = gates.get(path);
      if (!gate) {
        res.writeHead(404).end();
        return;
      }
      const prefix = Buffer.from(`event: ping\ndata: {\"stream\":\"${path}\"}\n\n`);
      const suffix = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      expected.set(path, Buffer.concat([prefix, suffix]));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(prefix);
      await gate.promise;
      res.end(suffix);
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 2_000,
      on: {},
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    const one = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/one`));
    const two = startCollecting(new URL(`http://127.0.0.1:${downstreamPort}/v1/two`));
    try {
      await Promise.all([one.firstChunk, two.firstChunk]);
      expect(one.hasCompleted()).toBe(false);
      expect(two.hasCompleted()).toBe(false);

      gates.get("/v1/one")!.resolve();
      expect(await one.completed).toEqual(expected.get("/v1/one"));
      expect(two.hasCompleted()).toBe(false);

      gates.get("/v1/two")!.resolve();
      expect(await two.completed).toEqual(expected.get("/v1/two"));
    } finally {
      gates.get("/v1/one")!.resolve();
      gates.get("/v1/two")!.resolve();
      await Promise.allSettled([one.completed, two.completed]);
      await close(downstream);
      await close(upstream);
    }
  });

  it("relays a failed response unchanged and mutates only the next-request routing state", async () => {
    const failureBody = Buffer.from("{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n");
    let upstreamRequests = 0;
    const upstream = createServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "invalid",
      });
      res.write(failureBody.subarray(0, 11));
      res.end(failureBody.subarray(11));
    });
    const upstreamPort = await listen(upstream);
    const invalidate = vi.fn();
    const setCooldown = vi.fn();
    const route = {
      account: { id: "account-a" },
      sessionId: "session-a",
    };

    const app = express();
    app.use("/v1", createAnthropicProxy({
      target: `http://127.0.0.1:${upstreamPort}`,
      timeoutMs: 2_000,
      on: {
        proxyRes: proxyResponse => {
          applyUpstreamFailureRouting(
            proxyResponse.statusCode ?? 0,
            proxyResponse.headers["retry-after"],
            route,
            { invalidate },
            { setCooldown },
          );
        },
      },
    }));
    const downstream = createServer(app);
    const downstreamPort = await listen(downstream);

    try {
      const response = await collect(new URL(`http://127.0.0.1:${downstreamPort}/v1/messages`));

      expect(response.status).toBe(429);
      expect(response.body).toEqual(failureBody);
      expect(upstreamRequests).toBe(1);
      expect(invalidate).toHaveBeenCalledWith("session-a", "account-a");
      expect(setCooldown).toHaveBeenCalledWith("account-a", 60_000);
      expect(response.body.toString("utf8")).not.toContain("message_stop");
    } finally {
      await close(downstream);
      await close(upstream);
    }
  });
});
