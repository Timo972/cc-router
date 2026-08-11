import { randomUUID } from "node:crypto";
import { PostHog, type PostHogOptions } from "posthog-node";
import { getTelemetrySnapshot, type TelemetrySnapshot } from "../config/telemetry.js";
import {
  ERROR_KINDS,
  MAX_STACK_FRAMES,
  MAX_STACK_FRAME_PATH_LENGTH,
  OPERATIONS,
  POSTHOG_FLUSH_AT,
  POSTHOG_FLUSH_INTERVAL_MS,
  POSTHOG_HOST,
  POSTHOG_MAX_QUEUE_SIZE,
  POSTHOG_PROJECT_TOKEN,
  POSTHOG_REQUEST_TIMEOUT_MS,
  PROVIDERS,
  RUNTIME_MODES,
  SETUP_REASONS,
  SETUP_STAGES,
  SYSTEM_ERROR_CODES,
} from "./constants.js";
import type { SafeAnalyticsEvent, SafeExceptionContract } from "./contracts.js";
import { reconstructAnalyticsEvent } from "./privacy.js";

export type PostHogTransport = NonNullable<PostHogOptions["fetch"]>;

export type PostHogSdkClient = Pick<
  PostHog,
  | "capture"
  | "captureImmediate"
  | "captureException"
  | "captureExceptionImmediate"
  | "flush"
  | "shutdown"
  | "getPersistedProperty"
  | "setPersistedProperty"
>;

export interface PostHogTelemetryClient {
  captureAnalytics(event: SafeAnalyticsEvent): void;
  captureAnalyticsImmediate(event: SafeAnalyticsEvent): Promise<void>;
  captureException(exception: SafeExceptionContract): void;
  captureExceptionImmediate(exception: SafeExceptionContract): Promise<void>;
  flushWithin(deadlineMs: number): Promise<void>;
  shutdownWithin(deadlineMs: number): Promise<void>;
  discardPending(): void;
}

export interface PostHogTelemetryClientOptions {
  getSnapshot?: () => TelemetrySnapshot;
  transport?: PostHogTransport;
  createSdkClient?: (token: string, options: PostHogOptions) => PostHogSdkClient;
}

type UnknownRecord = Record<string, unknown>;
type SdkEvent = Parameters<PostHog["capture"]>[0];
type PersistedKey = Parameters<PostHog["setPersistedProperty"]>[0];

const CAPTURE_GENERATION_PROPERTY = "__cc_router_capture_generation";
const CAPTURE_ID_PROPERTY = "__cc_router_capture_id";
const QUEUE_KEYS = ["queue", "ai_queue", "logs_queue"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(input: UnknownRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function member<const T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T[number]
    : undefined;
}

function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function httpStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function optionalMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): { valid: boolean; value?: T[number] } {
  if (value === undefined) return { valid: true };
  const normalized = member(values, value);
  return normalized === undefined ? { valid: false } : { valid: true, value: normalized };
}

function safeFramePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STACK_FRAME_PATH_LENGTH) {
    return undefined;
  }
  if (!value.startsWith("dist/") && !value.startsWith("node_modules/")) return undefined;
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0
    || segment === "."
    || segment === ".."
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
    || !/^[0-9A-Za-z@._+~-]+$/.test(segment))) {
    return undefined;
  }
  if (segments[0] === "node_modules") {
    const packageSegments = segments[1]?.startsWith("@") ? 2 : 1;
    if (segments.length < packageSegments + 2) return undefined;
  }
  return value;
}

function reconstructExceptionFrames(input: unknown): UnknownRecord[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_STACK_FRAMES) return undefined;
  const frames: UnknownRecord[] = [];
  for (const candidate of input) {
    if (!isRecord(candidate)) return undefined;
    const filename = safeFramePath(own(candidate, "filename"));
    const line = positiveInteger(own(candidate, "lineno"));
    const column = positiveInteger(own(candidate, "colno"));
    if (!filename || !line || !column) return undefined;
    frames.push({ platform: "node:javascript", filename, lineno: line, colno: column });
  }
  return frames;
}

function reconstructExceptionList(input: unknown, reason: string): UnknownRecord[] | undefined {
  if (!Array.isArray(input) || input.length !== 1 || !isRecord(input[0])) return undefined;
  const exception = input[0];
  const mechanism = own(exception, "mechanism");
  if (own(exception, "type") !== "Error"
    || own(exception, "value") !== reason
    || !isRecord(mechanism)
    || own(mechanism, "type") !== "generic"
    || own(mechanism, "handled") !== true
    || own(mechanism, "synthetic") !== false) {
    return undefined;
  }

  const stacktrace = own(exception, "stacktrace");
  if (stacktrace === undefined) {
    return [{ type: "Error", value: reason, mechanism: { type: "generic", handled: true, synthetic: false } }];
  }
  if (!isRecord(stacktrace) || own(stacktrace, "type") !== "raw") return undefined;
  const frames = reconstructExceptionFrames(own(stacktrace, "frames"));
  if (!frames) return undefined;
  return [{
    type: "Error",
    value: reason,
    mechanism: { type: "generic", handled: true, synthetic: false },
    stacktrace: { type: "raw", frames },
  }];
}

function reconstructExceptionEvent(event: SdkEvent, installationId: string, captureId: string): SdkEvent | null {
  if (event.event !== "$exception" || !isRecord(event.properties)) return null;
  const properties = event.properties;
  const category = own(properties, "category");
  const reason = member(SETUP_REASONS, own(properties, "reason"));
  const errorKind = member(ERROR_KINDS, own(properties, "errorKind"));
  const fingerprint = own(properties, "$exception_fingerprint");
  const diagnosticId = uuid(own(properties, "diagnosticId"));
  if ((category !== "setup" && category !== "runtime")
    || !reason
    || !errorKind
    || typeof fingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(fingerprint)
    || !diagnosticId
    || diagnosticId === installationId
    || own(properties, "$exception_level") !== "error") {
    return null;
  }

  const exceptionList = reconstructExceptionList(own(properties, "$exception_list"), reason);
  if (!exceptionList) return null;

  const systemErrorCode = optionalMember(SYSTEM_ERROR_CODES, own(properties, "systemErrorCode"));
  const operation = optionalMember(OPERATIONS, own(properties, "operation"));
  const provider = optionalMember(PROVIDERS, own(properties, "provider"));
  const setupStage = optionalMember(SETUP_STAGES, own(properties, "setupStage"));
  const runtimeMode = optionalMember(RUNTIME_MODES, own(properties, "runtimeMode"));
  const statusCandidate = own(properties, "httpStatusCode");
  const status = statusCandidate === undefined ? undefined : httpStatusCode(statusCandidate);
  if (!systemErrorCode.valid || !operation.valid || !provider.valid || !setupStage.valid || !runtimeMode.valid
    || (statusCandidate !== undefined && status === undefined)) {
    return null;
  }

  const safeProperties: Record<string, unknown> = {
    $exception_list: exceptionList,
    $exception_level: "error",
    $exception_fingerprint: fingerprint,
    category,
    reason,
    errorKind,
  };
  if (systemErrorCode.value !== undefined) safeProperties.systemErrorCode = systemErrorCode.value;
  if (status !== undefined) safeProperties.httpStatusCode = status;
  if (operation.value !== undefined) safeProperties.operation = operation.value;
  if (provider.value !== undefined) safeProperties.provider = provider.value;
  if (setupStage.value !== undefined) safeProperties.setupStage = setupStage.value;
  if (runtimeMode.value !== undefined) safeProperties.runtimeMode = runtimeMode.value;
  safeProperties.diagnosticId = diagnosticId;
  safeProperties.$process_person_profile = false;
  safeProperties.$geoip_disable = true;

  return {
    event: "$exception",
    distinctId: installationId,
    disableGeoip: true,
    uuid: captureId,
    properties: safeProperties,
  };
}

function safeSnapshot(getSnapshot: () => TelemetrySnapshot): TelemetrySnapshot | undefined {
  try {
    const snapshot = getSnapshot();
    return snapshot.enabled && uuid(snapshot.state.installId) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function noOpResponse(): Awaited<ReturnType<PostHogTransport>> {
  return {
    status: 204,
    text: async () => "",
    json: async () => ({}),
    headers: { get: () => null },
  };
}

function defaultTransport(): PostHogTransport {
  return async (url, options) => {
    const response = await globalThis.fetch(url, options as RequestInit);
    return response;
  };
}

function boundedDeadline(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

async function settleWithin(operation: () => Promise<void> | void, deadlineMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, boundedDeadline(deadlineMs));
      }),
    ]);
  } catch {
    // Telemetry lifecycle failures must never affect application behavior.
  } finally {
    clearTimeout(timeout);
  }
}

function exceptionProperties(
  exception: SafeExceptionContract,
  generation: number,
  captureId: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    $exception_fingerprint: exception.fingerprint,
    category: exception.category,
    reason: exception.reason,
    errorKind: exception.errorKind,
    diagnosticId: exception.diagnosticId,
    $process_person_profile: false,
    $geoip_disable: true,
    [CAPTURE_GENERATION_PROPERTY]: generation,
    [CAPTURE_ID_PROPERTY]: captureId,
  };
  if (exception.systemErrorCode !== undefined) properties.systemErrorCode = exception.systemErrorCode;
  if (exception.httpStatusCode !== undefined) properties.httpStatusCode = exception.httpStatusCode;
  if (exception.operation !== undefined) properties.operation = exception.operation;
  if (exception.provider !== undefined) properties.provider = exception.provider;
  if (exception.setupStage !== undefined) properties.setupStage = exception.setupStage;
  if (exception.runtimeMode !== undefined) properties.runtimeMode = exception.runtimeMode;
  return properties;
}

export function createPostHogTelemetryClient(
  options: PostHogTelemetryClientOptions = {},
): PostHogTelemetryClient {
  const getSnapshot = options.getSnapshot ?? getTelemetrySnapshot;
  const transport = options.transport ?? defaultTransport();
  const createSdkClient = options.createSdkClient ?? ((token, sdkOptions) => new PostHog(token, sdkOptions));
  let sdkClient: PostHogSdkClient | undefined;
  let initializationFailed = false;
  let shutdownStarted = false;
  let captureGeneration = 0;
  const preparedCaptureGenerations = new Map<string, number>();

  const beforeSend = (event: SdkEvent | null): SdkEvent | null => {
    try {
      if (!event || !isRecord(event.properties)) return null;
      const snapshot = safeSnapshot(getSnapshot);
      if (!snapshot) return null;
      const eventGeneration = own(event.properties, CAPTURE_GENERATION_PROPERTY);
      const captureId = uuid(own(event.properties, CAPTURE_ID_PROPERTY));
      if (!Number.isSafeInteger(eventGeneration) || eventGeneration !== captureGeneration || !captureId) return null;
      const installationId = uuid(snapshot.state.installId);
      if (!installationId) return null;

      if (event.event === "$exception") {
        const safe = reconstructExceptionEvent(event, installationId, captureId);
        if (safe) preparedCaptureGenerations.set(captureId, eventGeneration as number);
        return safe;
      }
      const diagnosticId = own(event.properties, "diagnosticId");
      const safe = reconstructAnalyticsEvent({
        event: event.event,
        properties: event.properties,
      }, {
        installationId,
        ...(typeof diagnosticId === "string" ? { diagnosticId } : {}),
      });
      if (!safe) return null;
      preparedCaptureGenerations.set(captureId, eventGeneration as number);
      return {
        event: safe.event,
        distinctId: safe.distinctId,
        disableGeoip: true,
        uuid: captureId,
        properties: {
          ...safe.properties,
          $process_person_profile: false,
          $geoip_disable: true,
        },
      };
    } catch {
      return null;
    }
  };

  const gatedFetch: PostHogTransport = async (url, fetchOptions) => {
    try {
      if (typeof fetchOptions.body !== "string") return noOpResponse();
      const payload: unknown = JSON.parse(fetchOptions.body);
      if (!isRecord(payload)) return noOpResponse();
      const batch = own(payload, "batch");
      if (!Array.isArray(batch)) return noOpResponse();

      const captureIds: string[] = [];
      const activeBatch: unknown[] = [];
      for (const candidate of batch) {
        if (!isRecord(candidate)) continue;
        const captureId = uuid(own(candidate, "uuid"));
        if (!captureId) continue;
        captureIds.push(captureId);
        if (preparedCaptureGenerations.get(captureId) === captureGeneration) {
          activeBatch.push(candidate);
        }
      }

      if (!safeSnapshot(getSnapshot) || activeBatch.length === 0) {
        for (const captureId of captureIds) preparedCaptureGenerations.delete(captureId);
        return noOpResponse();
      }

      const response = await transport(url, {
        ...fetchOptions,
        body: JSON.stringify({ ...payload, batch: activeBatch }),
      });
      const path = new URL(url).pathname;
      const accepted = response.status >= 200 && (path === "/batch/" ? response.status < 400 : response.status < 300);
      if (accepted) {
        for (const captureId of captureIds) preparedCaptureGenerations.delete(captureId);
      }
      return response;
    } catch {
      throw new Error("PostHog transport failed");
    }
  };

  const getClient = (): { client: PostHogSdkClient; installationId: string } | undefined => {
    if (shutdownStarted || initializationFailed) return undefined;
    const snapshot = safeSnapshot(getSnapshot);
    const installationId = snapshot && uuid(snapshot.state.installId);
    if (!snapshot || !installationId) return undefined;
    if (!sdkClient) {
      try {
        sdkClient = createSdkClient(POSTHOG_PROJECT_TOKEN, {
          host: POSTHOG_HOST,
          disableGeoip: true,
          enableExceptionAutocapture: false,
          disableRemoteConfig: true,
          disableRemoteFeatureFlags: true,
          flushAt: POSTHOG_FLUSH_AT,
          maxQueueSize: POSTHOG_MAX_QUEUE_SIZE,
          flushInterval: POSTHOG_FLUSH_INTERVAL_MS,
          requestTimeout: POSTHOG_REQUEST_TIMEOUT_MS,
          fetchRetryCount: 0,
          disableCompression: true,
          before_send: beforeSend,
          fetch: gatedFetch,
        });
      } catch {
        initializationFailed = true;
        return undefined;
      }
    }
    return { client: sdkClient, installationId };
  };

  return {
    captureAnalytics(event) {
      try {
        const active = getClient();
        if (!active) return;
        const captureId = randomUUID();
        active.client.capture({
          event: event.event,
          distinctId: active.installationId,
          disableGeoip: true,
          properties: {
            ...event.properties,
            $process_person_profile: false,
            $geoip_disable: true,
            [CAPTURE_GENERATION_PROPERTY]: captureGeneration,
            [CAPTURE_ID_PROPERTY]: captureId,
          },
        });
      } catch {
        // Capture is best effort only.
      }
    },
    async captureAnalyticsImmediate(event) {
      try {
        const active = getClient();
        if (!active) return;
        const captureId = randomUUID();
        await active.client.captureImmediate({
          event: event.event,
          distinctId: active.installationId,
          disableGeoip: true,
          properties: {
            ...event.properties,
            $process_person_profile: false,
            $geoip_disable: true,
            [CAPTURE_GENERATION_PROPERTY]: captureGeneration,
            [CAPTURE_ID_PROPERTY]: captureId,
          },
        });
      } catch {
        // Immediate CLI capture must not change command behavior.
      }
    },
    captureException(exception) {
      try {
        const active = getClient();
        if (!active) return;
        const captureId = randomUUID();
        active.client.captureException(
          exception.error,
          active.installationId,
          exceptionProperties(exception, captureGeneration, captureId),
        );
      } catch {
        // Capture is best effort only.
      }
    },
    async captureExceptionImmediate(exception) {
      try {
        const active = getClient();
        if (!active) return;
        const captureId = randomUUID();
        await active.client.captureExceptionImmediate(
          exception.error,
          active.installationId,
          exceptionProperties(exception, captureGeneration, captureId),
        );
      } catch {
        // Immediate CLI capture must not change command behavior.
      }
    },
    async flushWithin(deadlineMs) {
      const client = sdkClient;
      if (!client) return;
      await settleWithin(() => client.flush(), deadlineMs);
    },
    async shutdownWithin(deadlineMs) {
      const client = sdkClient;
      shutdownStarted = true;
      if (!client) return;
      await settleWithin(() => client.shutdown(boundedDeadline(deadlineMs)), deadlineMs);
      sdkClient = undefined;
    },
    discardPending() {
      captureGeneration += 1;
      for (const [captureId, generation] of preparedCaptureGenerations) {
        if (generation !== captureGeneration) preparedCaptureGenerations.delete(captureId);
      }
      const client = sdkClient;
      if (!client) return;
      for (const key of QUEUE_KEYS) {
        try {
          client.setPersistedProperty(key as PersistedKey, []);
        } catch {
          // Queue cleanup failures are isolated by the final transport gate.
        }
      }
    },
  };
}
