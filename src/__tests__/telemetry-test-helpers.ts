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
  readonly violations: CapturedTransportRequest[];
  endpoint(path?: string): string;
  assertOnlyApprovedRequests(): void;
  close(): Promise<void>;
}

export interface TransportCaptureOptions {
  responseMode?: "success" | "reset";
  allowUnapprovedRequests?: boolean;
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

export function semanticStrings(value: unknown): string[] {
  const strings: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      strings.push(candidate);
      const trimmed = candidate.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
        || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          visit(JSON.parse(trimmed) as unknown);
        } catch {
          // It only resembled JSON; the original string is still audited.
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate)) {
        strings.push(key);
        visit(item);
      }
    }
  };
  visit(value);
  return strings;
}

export function telemetryWireRepresentations(value: string): string[] {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([value, jsonEscaped])];
}

interface ProtobufField {
  number: number;
  wireType: number;
  value: number | bigint | Buffer;
}

function readVarint(buffer: Buffer, initialOffset: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = initialOffset;
  while (offset < buffer.length && shift < 70n) {
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("invalid protobuf varint");
}

function protobufFields(buffer: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (number === 0) throw new Error("invalid protobuf field number");
    if (wireType === 0) {
      const decoded = readVarint(buffer, offset);
      fields.push({ number, wireType, value: decoded.value });
      offset = decoded.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("truncated protobuf fixed64");
      fields.push({ number, wireType, value: buffer.readBigUInt64LE(offset) });
      offset += 8;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("truncated protobuf fixed32");
      fields.push({ number, wireType, value: buffer.readUInt32LE(offset) });
      offset += 4;
      continue;
    }
    if (wireType !== 2) throw new Error(`unsupported protobuf wire type ${wireType}`);
    const length = readVarint(buffer, offset);
    offset = length.offset;
    const end = offset + Number(length.value);
    if (end > buffer.length) throw new Error("truncated protobuf length-delimited field");
    fields.push({ number, wireType, value: buffer.subarray(offset, end) });
    offset = end;
  }
  return fields;
}

function bytes(field: ProtobufField): Buffer {
  if (!Buffer.isBuffer(field.value)) throw new Error(`protobuf field ${field.number} is not bytes`);
  return field.value;
}

function string(field: ProtobufField): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes(field));
}

function decodeAnyValue(buffer: Buffer): unknown {
  const [field] = protobufFields(buffer);
  if (!field) return undefined;
  switch (field.number) {
    case 1: return string(field);
    case 2: return field.value !== 0n;
    case 3: return Number(field.value);
    case 4: return bytes(field).readDoubleLE(0);
    case 5: return protobufFields(bytes(field))
      .filter(item => item.number === 1)
      .map(item => decodeAnyValue(bytes(item)));
    case 6: return Object.fromEntries(protobufFields(bytes(field))
      .filter(item => item.number === 1)
      .map(item => decodeKeyValue(bytes(item))));
    case 7: {
      const value = bytes(field);
      let utf8: string | undefined;
      try {
        utf8 = new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch {
        // Arbitrary bytes have no string semantic value.
      }
      return { base64: value.toString("base64"), ...(utf8 === undefined ? {} : { utf8 }) };
    }
    default: throw new Error(`unknown OTLP AnyValue field ${field.number}`);
  }
}

function decodeKeyValue(buffer: Buffer): [string, unknown] {
  const fields = protobufFields(buffer);
  const key = fields.find(field => field.number === 1);
  const value = fields.find(field => field.number === 2);
  if (!key || !value) throw new Error("invalid OTLP KeyValue");
  return [string(key), decodeAnyValue(bytes(value))];
}

function decodeAttributes(fields: ProtobufField[], number: number): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter(field => field.number === number)
    .map(field => decodeKeyValue(bytes(field))));
}

function decodeResource(buffer: Buffer): { attributes: Record<string, unknown> } {
  return { attributes: decodeAttributes(protobufFields(buffer), 1) };
}

function decodeScope(buffer: Buffer): Record<string, unknown> {
  const fields = protobufFields(buffer);
  const name = fields.find(field => field.number === 1);
  const version = fields.find(field => field.number === 2);
  return {
    ...(name ? { name: string(name) } : {}),
    ...(version ? { version: string(version) } : {}),
    attributes: decodeAttributes(fields, 3),
  };
}

function decodeStatus(buffer: Buffer): Record<string, unknown> {
  const fields = protobufFields(buffer);
  const message = fields.find(field => field.number === 2);
  const code = fields.find(field => field.number === 3);
  return {
    ...(message ? { message: string(message) } : {}),
    ...(code ? { code: Number(code.value) } : {}),
  };
}

function decodeSpan(buffer: Buffer): Record<string, unknown> {
  const fields = protobufFields(buffer);
  const traceState = fields.find(field => field.number === 3);
  const name = fields.find(field => field.number === 5);
  const status = fields.find(field => field.number === 15);
  return {
    ...(traceState ? { traceState: string(traceState) } : {}),
    ...(name ? { name: string(name) } : {}),
    attributes: decodeAttributes(fields, 9),
    events: fields.filter(field => field.number === 11).map(field => {
      const eventFields = protobufFields(bytes(field));
      const eventName = eventFields.find(item => item.number === 2);
      return {
        ...(eventName ? { name: string(eventName) } : {}),
        attributes: decodeAttributes(eventFields, 3),
      };
    }),
    links: fields.filter(field => field.number === 13).map(field => {
      const linkFields = protobufFields(bytes(field));
      const linkTraceState = linkFields.find(item => item.number === 3);
      return {
        ...(linkTraceState ? { traceState: string(linkTraceState) } : {}),
        attributes: decodeAttributes(linkFields, 4),
      };
    }),
    ...(status ? { status: decodeStatus(bytes(status)) } : {}),
  };
}

function decodeLogRecord(buffer: Buffer): Record<string, unknown> {
  const fields = protobufFields(buffer);
  const severityText = fields.find(field => field.number === 3);
  const body = fields.find(field => field.number === 5);
  const eventName = fields.find(field => field.number === 12);
  return {
    ...(severityText ? { severityText: string(severityText) } : {}),
    ...(body ? { body: decodeAnyValue(bytes(body)) } : {}),
    attributes: decodeAttributes(fields, 6),
    ...(eventName ? { eventName: string(eventName) } : {}),
  };
}

function decodeScopeRecords(
  buffer: Buffer,
  recordName: "spans" | "logRecords",
): Record<string, unknown> {
  const fields = protobufFields(buffer);
  const scope = fields.find(field => field.number === 1);
  const schemaUrl = fields.find(field => field.number === 3);
  return {
    ...(scope ? { scope: decodeScope(bytes(scope)) } : {}),
    [recordName]: fields.filter(field => field.number === 2).map(field =>
      recordName === "spans" ? decodeSpan(bytes(field)) : decodeLogRecord(bytes(field))
    ),
    ...(schemaUrl ? { schemaUrl: string(schemaUrl) } : {}),
  };
}

export function decodeOtlpProtobuf(
  input: Buffer,
  signal: "traces" | "logs",
): { resourceSpans?: unknown[]; resourceLogs?: unknown[] } {
  const resources = protobufFields(input).filter(field => field.number === 1).map(field => {
    const fields = protobufFields(bytes(field));
    const resource = fields.find(item => item.number === 1);
    const schemaUrl = fields.find(item => item.number === 3);
    return {
      ...(resource ? { resource: decodeResource(bytes(resource)) } : {}),
      [signal === "traces" ? "scopeSpans" : "scopeLogs"]: fields
        .filter(item => item.number === 2)
        .map(item => decodeScopeRecords(bytes(item), signal === "traces" ? "spans" : "logRecords")),
      ...(schemaUrl ? { schemaUrl: string(schemaUrl) } : {}),
    };
  });
  return signal === "traces" ? { resourceSpans: resources } : { resourceLogs: resources };
}

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

const APPROVED_TELEMETRY_REQUESTS = new Set([
  "POST /batch/",
  "POST /i/v1/traces",
  "POST /i/v1/logs",
]);

export async function startTransportCaptureServer(
  options: TransportCaptureOptions = {},
): Promise<TransportCaptureServer> {
  const requests: CapturedTransportRequest[] = [];
  const violations: CapturedTransportRequest[] = [];
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
      const captured = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        rawBody,
        json: parseJson(rawBody),
      };
      requests.push(captured);
      const requestKey = `${captured.method} ${captured.url}`;
      if (!APPROVED_TELEMETRY_REQUESTS.has(requestKey)) {
        violations.push(captured);
        const approvedPath = [...APPROVED_TELEMETRY_REQUESTS]
          .some(approved => approved.endsWith(` ${captured.url}`));
        response.statusCode = approvedPath ? 405 : 404;
        response.end();
        return;
      }
      if (options.responseMode === "reset") {
        request.socket.destroy();
        return;
      }
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
    violations,
    endpoint(path = "/") {
      const endpoint = new URL(path, origin).toString();
      assertLoopbackUrl(endpoint);
      return endpoint;
    },
    assertOnlyApprovedRequests() {
      if (violations.length > 0) {
        const attempted = violations.map(request => `${request.method} ${request.url}`).join(", ");
        throw new Error(`unapproved telemetry capture request(s): ${attempted}`);
      }
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      if (!options.allowUnapprovedRequests && violations.length > 0) {
        const attempted = violations.map(request => `${request.method} ${request.url}`).join(", ");
        throw new Error(`unapproved telemetry capture request(s): ${attempted}`);
      }
    },
  };
}
