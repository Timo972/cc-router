import { randomUUID } from "node:crypto";
import type { SetupMethod, SetupReason, SetupStage } from "./contracts.js";
import {
  flushTelemetryWithin,
  recordExpectedSetupFailure,
  recordSetupResult,
  recordSetupStage,
  recordSetupStageFailure,
  recordUnexpectedException,
  type ExpectedSetupFailureInput,
  type SetupStageInput,
} from "./facade.js";

export type SetupDiagnosticProvider = "anthropic" | "openai";

export interface SetupFailureClassification {
  stage: SetupStage;
  reason: SetupReason;
  expected: boolean;
  httpStatusCode?: number;
}

/**
 * A setup error keeps detailed text and its original cause local while exposing
 * a separate, closed classification to telemetry call sites.
 */
export class SetupDiagnosticError extends Error {
  readonly classification: SetupFailureClassification;

  constructor(
    localMessage: string,
    classification: SetupFailureClassification,
    options: { cause?: unknown } = {},
  ) {
    super(localMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SetupDiagnosticError";
    this.classification = { ...classification };
  }
}

export function classifyHttpSetupFailure(
  stage: SetupStage,
  status: number,
  localMessage: string,
  cause?: unknown,
): SetupDiagnosticError {
  let reason: SetupReason;
  if (status === 401) reason = "unauthorized";
  else if (status === 403) reason = "forbidden";
  else if (status === 429) reason = "rate_limited";
  else if (status >= 400 && status < 500) reason = "upstream_4xx";
  else if (status >= 500 && status < 600) reason = "upstream_5xx";
  else reason = "other";

  return new SetupDiagnosticError(localMessage, {
    stage,
    reason,
    expected: reason !== "other",
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatusCode: status }
      : {}),
  }, { cause });
}

function ownStringProperty(input: unknown, property: "code" | "name"): string | undefined {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, property);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownCause(input: unknown): unknown {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "cause");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeBuiltInErrorName(input: unknown): "AbortError" | "TimeoutError" | undefined {
  const ownName = ownStringProperty(input, "name");
  if (ownName === "AbortError" || ownName === "TimeoutError") return ownName;
  if (typeof DOMException === "undefined") return undefined;
  try {
    if (!(input instanceof DOMException)) return undefined;
  } catch {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
  if (!descriptor || typeof descriptor.get !== "function") return undefined;
  try {
    const name = descriptor.get.call(input) as unknown;
    return name === "AbortError" || name === "TimeoutError" ? name : undefined;
  } catch {
    return undefined;
  }
}

const NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

export function classifyNetworkSetupFailure(
  stage: SetupStage,
  cause: unknown,
  localMessage = cause instanceof Error ? cause.message : String(cause),
): SetupDiagnosticError {
  const name = safeBuiltInErrorName(cause);
  let code: string | undefined;
  let current: unknown = cause;
  const seen = new Set<unknown>();
  for (let depth = 0; depth <= 2 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = ownStringProperty(current, "code");
    if (candidate && NETWORK_CODES.has(candidate)) {
      code = candidate;
      break;
    }
    current = ownCause(current);
  }
  const reason: SetupReason = name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT"
    ? "timeout"
    : code && NETWORK_CODES.has(code)
      ? "network_failure"
      : "other";
  return new SetupDiagnosticError(localMessage, {
    stage,
    reason,
    expected: reason !== "other",
  }, { cause });
}

export interface CreateSetupAttemptInput {
  provider: SetupDiagnosticProvider;
  method: SetupMethod;
}

export interface SetupFailureOutcome {
  diagnosticId: string;
  unexpected: boolean;
}

export interface SetupAttempt {
  readonly provider: SetupDiagnosticProvider;
  readonly method: SetupMethod;
  readonly diagnosticId: string;
  stageCompleted(stage: SetupStage): void;
  stageFailed(error: unknown, fallbackStage: SetupStage): SetupFailureOutcome;
  failed(error: unknown, fallbackStage: SetupStage): SetupFailureOutcome;
  cancelled(): void;
  succeeded(): void;
}

function durationBucket(durationMs: number): SetupStageInput["durationBucket"] {
  if (durationMs < 1_000) return "under_1s";
  if (durationMs < 5_000) return "1s_to_5s";
  if (durationMs < 30_000) return "5s_to_30s";
  if (durationMs < 120_000) return "30s_to_2m";
  return "over_2m";
}

export function createSetupAttempt(input: CreateSetupAttemptInput): SetupAttempt {
  const startedAt = Date.now();
  const diagnosticId = randomUUID();
  const base = { provider: input.provider, method: input.method, diagnosticId };
  const withDuration = () => ({
    ...base,
    durationBucket: durationBucket(Math.max(0, Date.now() - startedAt)),
  });

  recordSetupStage({ ...withDuration(), stage: "attempt_start" });

  let terminal = false;
  const classify = (error: unknown, fallbackStage: SetupStage): SetupFailureClassification =>
    error instanceof SetupDiagnosticError
      ? error.classification
      : { stage: fallbackStage, reason: "other", expected: false };
  const failureInput = (classification: SetupFailureClassification): ExpectedSetupFailureInput => ({
    ...withDuration(),
    stage: classification.stage,
    reason: classification.reason,
    ...(classification.httpStatusCode === undefined
      ? {}
      : { httpStatusCode: classification.httpStatusCode }),
  });
  const recordException = (error: unknown, classification: SetupFailureClassification): void => {
    if (classification.expected) return;
    const exceptionCause = error instanceof SetupDiagnosticError && error.cause !== undefined
      ? error.cause
      : error;
    recordUnexpectedException(exceptionCause, {
      category: "setup",
      provider: input.provider,
      setupStage: classification.stage,
      reason: classification.reason,
    }, diagnosticId);
  };

  return {
    ...base,
    stageCompleted(stage): void {
      if (terminal) return;
      recordSetupStage({ ...withDuration(), stage });
    },
    stageFailed(error, fallbackStage): SetupFailureOutcome {
      const classification = classify(error, fallbackStage);
      if (!terminal) {
        recordSetupStageFailure(failureInput(classification));
        recordException(error, classification);
      }
      return { diagnosticId, unexpected: !classification.expected };
    },
    failed(error, fallbackStage): SetupFailureOutcome {
      const classification = classify(error, fallbackStage);
      if (!terminal) {
        terminal = true;
        recordExpectedSetupFailure(failureInput(classification));
        recordException(error, classification);
      }
      return { diagnosticId, unexpected: !classification.expected };
    },
    cancelled(): void {
      if (terminal) return;
      terminal = true;
      recordSetupResult({ ...withDuration(), result: "cancelled" });
    },
    succeeded(): void {
      if (terminal) return;
      terminal = true;
      recordSetupResult({ ...withDuration(), result: "succeeded" });
    },
  };
}

export const SETUP_TELEMETRY_FLUSH_DEADLINE_MS = 1_500;

/** Never let a bounded telemetry flush change or delay a command result. */
export async function withSetupTelemetryFlush<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } finally {
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, SETUP_TELEMETRY_FLUSH_DEADLINE_MS);
      void Promise.resolve()
        .then(() => flushTelemetryWithin(SETUP_TELEMETRY_FLUSH_DEADLINE_MS))
        .then(finish, finish);
    });
  }
}

export function isPromptCancellation(error: unknown): boolean {
  return ownStringProperty(error, "name") === "ExitPromptError";
}

/**
 * Close an attempt that ended in a thrown error: a cancelled prompt is a user
 * decision (no outcome returned); anything else is a failure at the given stage.
 */
export function failAttemptFromError(
  attempt: SetupAttempt,
  error: unknown,
  fallbackStage: SetupStage,
): SetupFailureOutcome | undefined {
  if (isPromptCancellation(error)) {
    attempt.cancelled();
    return undefined;
  }
  return attempt.failed(error, fallbackStage);
}
