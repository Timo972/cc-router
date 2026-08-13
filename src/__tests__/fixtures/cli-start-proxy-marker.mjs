import { appendFileSync } from "node:fs";

export async function startServer() {
  appendFileSync(process.env.CC_ROUTER_TEST_PROXY_MARKER, "started\n");
}
