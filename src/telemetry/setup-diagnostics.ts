import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  DiagnosticId,
  SafeExceptionContext,
  SetupMethod,
  SetupReason,
  SetupStage,
} from "./contracts.js";
import {
  flushTelemetryWithin,
  recordExpectedSetupFailure,
  recordSetupResult,
  recordSetupStage,
  recordUnexpectedException,
  type ExpectedSetupFailureInput,
  type SetupResultInput,
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
  const descriptor = Object.getOwnPropertyDescriptor(input, property);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
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
  const name = ownStringProperty(cause, "name");
  const code = ownStringProperty(cause, "code");
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

export interface SetupDiagnosticRecorder {
  recordSetupStage(input: SetupStageInput): void;
  recordSetupResult(input: SetupResultInput): void;
  recordExpectedSetupFailure(input: ExpectedSetupFailureInput): void;
  recordUnexpectedException(
    error: unknown,
    context: SafeExceptionContext,
    diagnosticId?: string,
  ): DiagnosticId | undefined;
  flushTelemetryWithin(deadlineMs: number): Promise<void>;
}

const defaultRecorder: SetupDiagnosticRecorder = {
  recordSetupStage,
  recordSetupResult,
  recordExpectedSetupFailure,
  recordUnexpectedException,
  flushTelemetryWithin,
};

export interface CreateSetupAttemptInput {
  provider: SetupDiagnosticProvider;
  method: SetupMethod;
  recorder?: SetupDiagnosticRecorder;
  randomUUID?: () => string;
  now?: () => number;
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

function validDiagnosticId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createSetupAttempt(input: CreateSetupAttemptInput): SetupAttempt {
  const recorder = input.recorder ?? defaultRecorder;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const candidate = (input.randomUUID ?? nodeRandomUUID)();
  const diagnosticId = validDiagnosticId(candidate) ? candidate : nodeRandomUUID();
  const base = {
    provider: input.provider,
    method: input.method,
    diagnosticId,
  };
  const withDuration = () => ({
    ...base,
    durationBucket: durationBucket(Math.max(0, now() - startedAt)),
  });

  recorder.recordSetupStage({ ...withDuration(), stage: "attempt_start" });

  return {
    ...base,
    stageCompleted(stage): void {
      recorder.recordSetupStage({ ...withDuration(), stage });
    },
    failed(error, fallbackStage): SetupFailureOutcome {
      const classification = error instanceof SetupDiagnosticError
        ? error.classification
        : { stage: fallbackStage, reason: "other" as const, expected: false };
      recorder.recordExpectedSetupFailure({
        ...withDuration(),
        stage: classification.stage,
        reason: classification.reason,
        ...(classification.httpStatusCode === undefined
          ? {}
          : { httpStatusCode: classification.httpStatusCode }),
      });
      if (!classification.expected) {
        const exceptionCause = error instanceof SetupDiagnosticError && error.cause !== undefined
          ? error.cause
          : error;
        recorder.recordUnexpectedException(exceptionCause, {
          category: "setup",
          provider: input.provider,
          setupStage: classification.stage,
          reason: classification.reason,
        }, diagnosticId);
      }
      return { diagnosticId, unexpected: !classification.expected };
    },
    cancelled(): void {
      recorder.recordSetupResult({ ...withDuration(), result: "cancelled" });
    },
    succeeded(): void {
      recorder.recordSetupResult({ ...withDuration(), result: "succeeded" });
    },
  };
}

export async function persistSetupAttempts(
  attempts: readonly SetupAttempt[],
  persist: () => void | Promise<void>,
): Promise<void> {
  try {
    await persist();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new SetupDiagnosticError(`Account persistence failed: ${detail}`, {
      stage: "persistence",
      reason: "persistence_failure",
      expected: false,
    }, { cause });
    for (const attempt of attempts) attempt.failed(error, "persistence");
    throw error;
  }
  for (const attempt of attempts) {
    attempt.stageCompleted("persistence");
    attempt.succeeded();
  }
}

export const SETUP_TELEMETRY_FLUSH_DEADLINE_MS = 1_500;

export async function withSetupTelemetryFlush<T>(
  operation: () => Promise<T>,
  flush: (deadlineMs: number) => Promise<void> = flushTelemetryWithin,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await flush(SETUP_TELEMETRY_FLUSH_DEADLINE_MS).catch(() => undefined);
  }
}

export function isPromptCancellation(error: unknown): boolean {
  return ownStringProperty(error, "name") === "ExitPromptError";
}
