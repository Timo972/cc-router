import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { isIP, type AddressInfo } from "node:net";

export interface CapturedTransportRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  json: unknown | undefined;
}

export interface TransportCaptureServer {
  readonly origin: string;
  readonly requests: CapturedTransportRequest[];
  endpoint(path?: string): string;
  close(): Promise<void>;
}

export const TELEMETRY_CANARY = {
  prompt: "telemetry-canary-prompt: never export this prompt",
  bearerToken: "Bearer telemetry-canary-bearer-token",
  email: "telemetry-canary@example.test",
  accountId: "telemetry-canary-account-id",
  hostname: "telemetry-canary-hostname",
  homePath: "/Users/telemetry-canary",
  queryString: "?telemetry_canary_query=never-export",
  headerValue: "telemetry-canary-header-value",
  rawProviderBody: JSON.stringify({
    model: "telemetry-canary-model",
    messages: [{ role: "user", content: "telemetry-canary-provider-body" }],
  }),
  exceptionMessage: "telemetry-canary-raw-exception-message",
} as const;

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLoopbackHostname(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "");
  if (isIP(address) === 4) return address.startsWith("127.");
  return address === "::1";
}

export function assertLoopbackUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`transport capture URL must use HTTP(S): ${url.protocol}`);
  }

  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`telemetry test transport must remain on loopback: ${url.hostname}`);
  }

  return url;
}

function parseJson(rawBody: Buffer): unknown | undefined {
  if (rawBody.length === 0) return undefined;

  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startTransportCaptureServer(): Promise<TransportCaptureServer> {
  const requests: CapturedTransportRequest[] = [];
  const server = createServer((request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.statusCode = 403;
      response.end("telemetry test transport must remain on loopback");
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        rawBody,
        json: parseJson(rawBody),
      });
      response.statusCode = 200;
      response.end();
    });
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    throw new Error("transport capture server did not bind to a TCP port");
  }

  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return {
    origin,
    requests,
    endpoint(path = "/") {
      const endpoint = new URL(path, origin).toString();
      assertLoopbackUrl(endpoint);
      return endpoint;
    },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
