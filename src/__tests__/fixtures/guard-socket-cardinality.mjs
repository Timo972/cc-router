import http from "node:http";
import net from "node:net";

const origin = new URL(process.env.CC_ROUTER_EU_OFFLINE_CAPTURE_ORIGIN);
const exact = { host: origin.hostname, port: Number(origin.port) };
const results = {};

function attempt(label, socket, options = exact) {
  try {
    socket.connect(options);
    results[label] = "allowed";
  } catch {
    results[label] = "blocked";
  }
}

class CardinalityAgent extends http.Agent {
  createConnection() {
    const first = new net.Socket();
    attempt("first", first);

    const secondLive = new net.Socket();
    attempt("secondLive", secondLive);

    first.destroy();
    const mismatch = new net.Socket();
    attempt("mismatch", mismatch, { host: origin.hostname, port: Number(origin.port) + 1 });

    const replacement = new net.Socket();
    attempt("replacement", replacement);
    replacement.destroy();

    const third = new net.Socket();
    attempt("third", third);
    third.destroy();
    throw new Error("controlled cardinality probe complete");
  }
}

try {
  const request = http.request({
    protocol: "http:",
    hostname: origin.hostname,
    port: origin.port,
    path: "/batch/",
    method: "POST",
    agent: new CardinalityAgent(),
  });
  request.on("error", () => undefined);
  request.end("{}");
} catch {
  // The agent throws after synchronously exercising every authorized branch.
}

const noProvenance = new net.Socket();
attempt("noProvenance", noProvenance);
noProvenance.destroy();
process.stdout.write(`${JSON.stringify(results)}\n`);
