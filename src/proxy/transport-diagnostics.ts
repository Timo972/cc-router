import { randomUUID } from "node:crypto";

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,48}$/;
const SAFE_CORRELATION = /^[A-Za-z0-9-]{1,48}$/;

export type TransportDiagnostic = {
  correlationId: string;
  operation: "prepare" | "refresh" | "forward" | "upstream" | "relay";
  status?: number;
  causeCode?: string;
};

export function createCorrelationId(): string {
  return `oai-${randomUUID().slice(0, 8)}`;
}

export function safeCauseCode(error: unknown): string | undefined {
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 3 && typeof cause === "object" && cause !== null; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

export function formatTransportDiagnostic(diagnostic: TransportDiagnostic): string {
  const correlationId = SAFE_CORRELATION.test(diagnostic.correlationId)
    ? diagnostic.correlationId
    : "invalid";
  const fields = [
    `correlation=${correlationId}`,
    `operation=${diagnostic.operation}`,
  ];
  if (diagnostic.status !== undefined && Number.isInteger(diagnostic.status)) {
    fields.push(`status=${diagnostic.status}`);
  }
  if (diagnostic.causeCode !== undefined && SAFE_CODE.test(diagnostic.causeCode)) {
    fields.push(`cause=${diagnostic.causeCode}`);
  }
  return fields.join(" ");
}
