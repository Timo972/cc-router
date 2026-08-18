export const RUNTIME_MODES = ["foreground", "daemon", "service"] as const;
export const PROVIDERS = ["anthropic", "openai", "other"] as const;
export const ROUTES = ["messages", "responses", "other"] as const;
export const REQUEST_SOURCES = ["cli", "desktop", "api", "other"] as const;
export const MODEL_FAMILIES = ["fable", "sonnet", "opus", "haiku", "codex", "other"] as const;

export const OPERATIONS = [
  "proxy.request",
  "provider.inference",
  "oauth.refresh",
  "provider.usage_refresh",
  "model.discovery",
] as const;

export const SETUP_METHODS = [
  "macos_keychain",
  "claude_credentials_file",
  "manual_token",
  "device_oauth",
] as const;

export const SETUP_STAGES = [
  "attempt_start",
  "credential_source_selection",
  "credential_read",
  "credential_parse",
  "token_validation",
  "device_code_request",
  "authorization_polling",
  "token_exchange",
  "access_token_parse",
  "persistence",
  "success",
  "cancellation",
  "failure",
] as const;

export const SETUP_REASONS = [
  "not_found",
  "permission_denied",
  "malformed_credentials",
  "invalid_token",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "upstream_4xx",
  "upstream_5xx",
  "timeout",
  "network_failure",
  "unexpected_response_shape",
  "persistence_failure",
  "user_cancelled",
  "other",
] as const;

export const OUTCOMES = [
  "complete",
  "rate_limited",
  "timeout",
  "upstream_error",
  "cancelled",
  "other",
] as const;

export const STREAM_OUTCOMES = [
  "complete",
  "timeout",
  "upstream_error",
  "cancelled",
  "other",
] as const;

export const ERROR_KINDS = [
  "error",
  "type_error",
  "range_error",
  "reference_error",
  "syntax_error",
  "uri_error",
  "eval_error",
  "aggregate_error",
  "unexpected_error",
] as const;

export const SYSTEM_ERROR_CODES = [
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
] as const;

export const SEVERITIES = ["info", "warn", "error", "fatal"] as const;
export const HTTP_METHODS = ["GET", "POST"] as const;
export const SPAN_KINDS = ["internal", "server", "client"] as const;
export const SPAN_STATUS_CODES = ["unset", "ok", "error"] as const;
export const OS_FAMILIES = ["macos", "linux", "windows", "other"] as const;
export const CPU_ARCHITECTURES = ["arm64", "x64", "other"] as const;
export const DURATION_BUCKETS = [
  "under_1s",
  "1s_to_5s",
  "5s_to_30s",
  "30s_to_2m",
  "over_2m",
] as const;

export const INSTRUMENTATION_SCOPES = [
  "cc-router",
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-express",
  "@opentelemetry/instrumentation-undici",
] as const;

export const LOG_EVENT_CODES = ["account.setup.diagnostic", "runtime.failure"] as const;
export const ANALYTICS_EVENT_NAMES = [
  "app.first_start",
  "account_setup.started",
  "account_setup.stage_completed",
  "account_setup.succeeded",
  "account_setup.cancelled",
  "account_setup.failed",
  "proxy.started",
  "proxy.heartbeat",
] as const;

export const MAX_VERSION_LENGTH = 64;
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_ATTEMPT = 100;
export const MAX_ACCOUNT_POOL_SIZE = 10_000;
export const MAX_CONCURRENCY = 10_000;
export const MAX_TOKEN_COUNT = 1_000_000_000;
export const MAX_STACK_FRAMES = 20;
export const MAX_STACK_FRAME_PATH_LENGTH = 256;

export const POSTHOG_HOST = "https://eu.i.posthog.com";
export const POSTHOG_INGESTION_HOSTNAME = "eu.i.posthog.com";
export const POSTHOG_PROJECT_TOKEN = "phc_n7wcYbbfMSkNxRoB8JVd57PYQZf7DNaEGL2kUeUkxwV2";
export const POSTHOG_REQUEST_TIMEOUT_MS = 2_000;
export const POSTHOG_FLUSH_INTERVAL_MS = 5_000;
export const POSTHOG_FLUSH_AT = 20;
export const POSTHOG_MAX_QUEUE_SIZE = 100;

if (!/^phc_[0-9A-Za-z]+$/.test(POSTHOG_PROJECT_TOKEN)) {
  throw new Error("PostHog telemetry requires a public project token");
}
