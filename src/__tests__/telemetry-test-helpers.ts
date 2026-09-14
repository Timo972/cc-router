import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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
  endpoint(path: string): string;
  close(): Promise<void>;
}

/** Values that must never leave the process, in every shape a leak could take. */
export const TELEMETRY_CANARY = {
  prompt: "telemetry-canary-prompt: never export this prompt",
  bearerToken: "Bearer telemetry-canary-bearer-token",
  email: "telemetry-canary@example.test",
  accountId: "telemetry-canary-account-id",
  hostname: "telemetry-canary-hostname",
  homePath: "/Users/telemetry-canary",
  exceptionMessage: "telemetry-canary-raw-exception-message",
} as const;

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
      fields.push({ number, wireType, value: buffer.readBigUInt64LE(offset) });
      offset += 8;
      continue;
    }
    if (wireType === 5) {
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
    default: return bytes(field).toString("base64");
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

export interface DecodedSpan {
  name: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  scope: string | undefined;
}

function decodeSpan(buffer: Buffer): Omit<DecodedSpan, "resource" | "scope"> {
  const fields = protobufFields(buffer);
  const name = fields.find(field => field.number === 5);
  return {
    name: name ? string(name) : "",
    attributes: decodeAttributes(fields, 9),
  };
}

/** Decode the OTLP/protobuf trace payload the PostHog span exporter writes. */
export function decodeOtlpSpans(input: Buffer): DecodedSpan[] {
  return protobufFields(input).filter(field => field.number === 1).flatMap(resourceSpan => {
    const resourceFields = protobufFields(bytes(resourceSpan));
    const resource = resourceFields.find(field => field.number === 1);
    const resourceAttributes = resource
      ? decodeAttributes(protobufFields(bytes(resource)), 1)
      : {};
    return resourceFields.filter(field => field.number === 2).flatMap(scopeSpan => {
      const scopeFields = protobufFields(bytes(scopeSpan));
      const scope = scopeFields.find(field => field.number === 1);
      const scopeName = scope
        ? protobufFields(bytes(scope)).find(field => field.number === 1)
        : undefined;
      return scopeFields.filter(field => field.number === 2).map(span => ({
        ...decodeSpan(bytes(span)),
        resource: resourceAttributes,
        scope: scopeName ? string(scopeName) : undefined,
      }));
    });
  });
}

function parseJson(rawBody: Buffer): unknown | undefined {
  if (rawBody.length === 0) return undefined;
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Loopback OTLP/PostHog endpoint. Every byte the telemetry stack would send to
 * the network is captured here instead, so tests can audit the wire directly.
 */
export interface TransportCaptureOptions {
  /** "reset" destroys the socket without answering, simulating a failed transport. */
  responseMode?: "success" | "reset";
}

export async function startTransportCaptureServer(
  options: TransportCaptureOptions = {},
): Promise<TransportCaptureServer> {
  const requests: CapturedTransportRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (options.responseMode === "reset") {
        request.socket.destroy();
        return;
      }
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    endpoint: (path: string) => `${origin}${path}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Every string the wire could carry, including its JSON-escaped form. */
export function wireText(requests: readonly CapturedTransportRequest[]): string {
  return requests.map(request => request.rawBody.toString("utf8")).join("\n");
}

export function assertNoCanaries(requests: readonly CapturedTransportRequest[]): void {
  const text = wireText(requests);
  for (const canary of Object.values(TELEMETRY_CANARY)) {
    const escaped = JSON.stringify(canary).slice(1, -1);
    if (text.includes(canary) || text.includes(escaped)) {
      throw new Error(`telemetry wire leaked a canary value: ${canary}`);
    }
  }
}
