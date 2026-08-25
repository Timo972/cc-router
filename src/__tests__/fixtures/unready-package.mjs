#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const markerPath = process.env["CC_ROUTER_TEST_STARTUP_MARKER"];
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (!markerPath || !Number.isInteger(port)) throw new Error("invalid readiness fixture inputs");

const server = createServer((_request, response) => {
  response.statusCode = 503;
  response.end("not ready");
});
server.listen(port, "127.0.0.1", () => {
  writeFileSync(markerPath, JSON.stringify({ pid: process.pid, home: process.env["HOME"], port }));
});
