import { describe, expect, it } from "vitest";
import { sanitizeException } from "../telemetry/privacy.js";

const INSTALL_ID = "70d8062e-1fa0-4ae4-a115-bf782ecca462";
const OTHER_INSTALL_ID = "916ce1d6-2e8d-48b2-a70e-0337bdf82df7";
const DIAGNOSTIC_ID = "ad94f035-1e08-4e29-8517-fd56bdc83d99";
const NEXT_DIAGNOSTIC_ID = "57b50aa2-fb24-40af-965b-cd5f2e506cdc";
const PROJECT_ROOT = "/Users/alice/work/cc-router";
const TRUSTED_SOURCE = { projectRoot: PROJECT_ROOT };

const context = {
  category: "setup",
  reason: "persistence_failure",
  operation: "oauth.refresh",
  provider: "openai",
  setupStage: "persistence",
  runtimeMode: "foreground",
};

function hostileError(message: string): TypeError {
  const error = new TypeError(message, {
    cause: Object.assign(new Error("nested PRIVATE_CAUSE"), {
      token: "sk-nested-secret",
      path: "/Users/alice/.cc-router/accounts.json",
    }),
  });
  Object.assign(error, {
    code: "ECONNRESET",
    status: 502,
    token: "sk-top-level-secret",
    requestUrl: "https://alice:password@example.test/private",
    response: { body: "PRIVATE_RESPONSE_BODY" },
  });
  error.stack = [
    `TypeError: ${message}`,
    "    at persist (/Users/alice/work/cc-router/dist/config/store.js:42:7)",
    "    at load (file:///Users/alice/work/cc-router/dist/state/load.js:8:2)",
    "    at scoped (/Users/alice/work/cc-router/node_modules/@scope/safe-package/lib/index.js:19:4)",
    "    at nested (/Users/alice/work/cc-router/node_modules/outer/node_modules/inner/lib.js:3:9)",
    "    at source (/Users/alice/work/cc-router/src/private-source.ts:12:5)",
    "    at remote (https://alice:password@example.test/dist/leak.js:2:2)",
    "    at home (/Users/alice/private/secrets.js:1:1)",
    "PRIVATE_SOURCE_CONTEXT = sk-stack-secret",
  ].join("\n");
  return error;
}

describe("exception sanitization", () => {
  it("reconstructs a hostile Error without messages, causes, properties, or identifying paths", () => {
    const original = hostileError("Bearer PRIVATE_MESSAGE");

    const result = sanitizeException(original, {
      ...context,
      prompt: "PRIVATE_PROMPT",
      workspace: "/Users/alice/work/cc-router",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(result).toEqual(expect.objectContaining({
      category: "setup",
      reason: "persistence_failure",
      errorKind: "type_error",
      systemErrorCode: "ECONNRESET",
      httpStatusCode: 502,
      operation: "oauth.refresh",
      provider: "openai",
      setupStage: "persistence",
      runtimeMode: "foreground",
      diagnosticId: DIAGNOSTIC_ID,
      frames: [
        { path: "dist/config/store.js", line: 42, column: 7 },
        { path: "dist/state/load.js", line: 8, column: 2 },
        { path: "node_modules/@scope/safe-package/lib/index.js", line: 19, column: 4 },
        { path: "node_modules/inner/lib.js", line: 3, column: 9 },
      ],
    }));
    expect(result?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.error).toBeInstanceOf(Error);
    expect(result?.error).not.toBe(original);
    expect(result?.error.message).toBe("persistence_failure");
    expect(Object.keys(result?.error ?? {})).toEqual([]);
    expect("cause" in (result?.error ?? {})).toBe(false);
    expect(result?.error.stack).toBe([
      "Error: persistence_failure",
      "    at dist/config/store.js:42:7",
      "    at dist/state/load.js:8:2",
      "    at node_modules/@scope/safe-package/lib/index.js:19:4",
      "    at node_modules/inner/lib.js:3:9",
    ].join("\n"));

    const serialized = JSON.stringify(result);
    for (const secret of [
      "PRIVATE_MESSAGE",
      "PRIVATE_CAUSE",
      "PRIVATE_PROMPT",
      "PRIVATE_RESPONSE_BODY",
      "PRIVATE_SOURCE_CONTEXT",
      "sk-top-level-secret",
      "sk-nested-secret",
      "/Users/alice",
      "alice:password",
      "private-source",
    ]) {
      expect(serialized).not.toContain(secret);
      expect(result?.error.stack).not.toContain(secret);
    }
  });

  it("groups the same safe fault independently of its raw message and diagnostic occurrence", () => {
    const first = sanitizeException(hostileError("account alice@example.test failed"), context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const second = sanitizeException(hostileError("token sk-different-secret failed"), context, {
      installationId: INSTALL_ID,
      diagnosticId: NEXT_DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const otherInstall = sanitizeException(hostileError("third private message"), context, {
      installationId: OTHER_INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.fingerprint).toBe(otherInstall?.fingerprint);
    expect(first?.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(second?.diagnosticId).toBe(NEXT_DIAGNOSTIC_ID);
    expect(first?.diagnosticId).not.toBe(INSTALL_ID);
    expect(second?.diagnosticId).not.toBe(INSTALL_ID);
  });

  it("changes grouping when safe context or a normalized frame changes", () => {
    const original = hostileError("same private message");
    const baseline = sanitizeException(original, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const changedContext = sanitizeException(original, { ...context, setupStage: "credential_parse" }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const changedStackError = hostileError("same private message");
    changedStackError.stack = changedStackError.stack?.replace("store.js:42:7", "store.js:43:7");
    const changedStack = sanitizeException(changedStackError, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(changedContext?.fingerprint).not.toBe(baseline?.fingerprint);
    expect(changedStack?.fingerprint).not.toBe(baseline?.fingerprint);
  });

  it("retains safe classification for an unexpected parser or state failure", () => {
    const parserFailure = new SyntaxError("Unexpected token containing PRIVATE_JSON");
    parserFailure.stack = [
      "SyntaxError: Unexpected token containing PRIVATE_JSON",
      `    at parse (${PROJECT_ROOT}/dist/auth/parser.js:71:13)`,
    ].join("\n");

    const result = sanitizeException(parserFailure, {
      category: "setup",
      reason: "malformed_credentials",
      operation: "model.discovery",
      provider: "anthropic",
      setupStage: "credential_parse",
      runtimeMode: "daemon",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(result).toEqual(expect.objectContaining({
      category: "setup",
      reason: "malformed_credentials",
      errorKind: "syntax_error",
      operation: "model.discovery",
      provider: "anthropic",
      setupStage: "credential_parse",
      runtimeMode: "daemon",
      diagnosticId: DIAGNOSTIC_ID,
      frames: [{ path: "dist/auth/parser.js", line: 71, column: 13 }],
    }));
    expect(result?.reason).not.toBe("other");
    expect(result?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.error.stack).not.toContain("PRIVATE_JSON");
  });

  it("uses unexpected_error without inspecting arbitrary thrown values", () => {
    const thrown = {
      message: "PRIVATE_MESSAGE",
      stack: "/Users/alice/work/cc-router/dist/private.js:1:2",
      cause: new Error("PRIVATE_CAUSE"),
      code: "ECONNRESET",
      statusCode: 503,
    };

    const result = sanitizeException(thrown, {
      category: "runtime",
      reason: "private raw reason",
      operation: "proxy.request",
      provider: "private-provider",
      runtimeMode: "daemon",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(result).toEqual(expect.objectContaining({
      category: "runtime",
      reason: "other",
      errorKind: "unexpected_error",
      operation: "proxy.request",
      provider: "other",
      runtimeMode: "daemon",
      frames: [],
      diagnosticId: DIAGNOSTIC_ID,
    }));
    expect(result).not.toHaveProperty("systemErrorCode");
    expect(result).not.toHaveProperty("httpStatusCode");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("does not let a hostile thrown proxy escape the telemetry boundary", () => {
    const thrown = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("PRIVATE_PROXY_TRAP");
      },
      get() {
        throw new Error("PRIVATE_PROXY_GETTER");
      },
    });

    expect(() => sanitizeException(thrown, {
      category: "runtime",
      reason: "other",
      operation: "proxy.request",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE)).not.toThrow();
    expect(sanitizeException(thrown, {
      category: "runtime",
      reason: "other",
      operation: "proxy.request",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE)?.errorKind).toBe("unexpected_error");
  });

  it.each([
    [{ code: "ERR_PRIVATE", status: 200 }, { httpStatusCode: 200 }],
    [{ code: "econnreset", status: 99 }, {}],
    [{ code: "ETIMEDOUT", status: "504" }, { systemErrorCode: "ETIMEDOUT" }],
    [{ code: "ENOTFOUND", statusCode: 599 }, { systemErrorCode: "ENOTFOUND", httpStatusCode: 599 }],
  ])("allowlists only exact system codes and numeric HTTP statuses", (properties, expected) => {
    const error = Object.assign(new Error("PRIVATE"), properties);
    error.stack = `Error: PRIVATE\n    at run (${PROJECT_ROOT}/dist/run.js:1:2)`;

    const result = sanitizeException(error, {
      category: "runtime",
      reason: "network_failure",
      operation: "provider.inference",
    }, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(result).toEqual(expect.objectContaining(expected));
    if (!("systemErrorCode" in expected)) expect(result).not.toHaveProperty("systemErrorCode");
    if (!("httpStatusCode" in expected)) expect(result).not.toHaveProperty("httpStatusCode");
  });

  it.each([
    { installationId: "not-a-uuid", diagnosticId: DIAGNOSTIC_ID },
    { installationId: INSTALL_ID },
    { installationId: INSTALL_ID, diagnosticId: "not-a-uuid" },
    { installationId: INSTALL_ID, diagnosticId: INSTALL_ID },
  ])("rejects an invalid or non-ephemeral trusted diagnostic identity", (identity) => {
    expect(sanitizeException(new Error("PRIVATE"), context, identity, TRUSTED_SOURCE)).toBeUndefined();
  });

  it("removes the complete multiline Error message before parsing stack frames", () => {
    const multilineError = (message: string, injectedFrame: string) => new Error([
      message,
      injectedFrame,
    ].join("\n"));
    const first = multilineError(
      "PRIVATE_MULTILINE_A",
      `    at ${PROJECT_ROOT}/dist/injected-a.js:1:2`,
    );
    const second = multilineError(
      "PRIVATE_MULTILINE_B",
      `    at ${PROJECT_ROOT}/dist/injected-b.js:8:9`,
    );

    const firstResult = sanitizeException(first, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const secondResult = sanitizeException(second, context, {
      installationId: INSTALL_ID,
      diagnosticId: NEXT_DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(firstResult?.frames).not.toContainEqual(expect.objectContaining({ path: "dist/injected-a.js" }));
    expect(secondResult?.frames).not.toContainEqual(expect.objectContaining({ path: "dist/injected-b.js" }));
    expect(firstResult?.fingerprint).toBe(secondResult?.fingerprint);
    for (const canary of ["PRIVATE_MULTILINE", "injected-a", "injected-b"]) {
      expect(firstResult?.error.stack).not.toContain(canary);
      expect(secondResult?.error.stack).not.toContain(canary);
      expect(JSON.stringify(firstResult)).not.toContain(canary);
      expect(JSON.stringify(secondResult)).not.toContain(canary);
    }
  });

  it("drops all frames when the complete Error header cannot be verified", () => {
    const first = new Error("PRIVATE_ACTUAL_A");
    first.stack = [
      "Error: PRIVATE_DIFFERENT_A",
      `    at injected (${PROJECT_ROOT}/dist/header-a.js:4:5)`,
    ].join("\n");
    const second = new Error("PRIVATE_ACTUAL_B");
    second.stack = [
      "Error: PRIVATE_DIFFERENT_B",
      `    at injected (${PROJECT_ROOT}/dist/header-b.js:6:7)`,
    ].join("\n");

    const firstResult = sanitizeException(first, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const secondResult = sanitizeException(second, context, {
      installationId: INSTALL_ID,
      diagnosticId: NEXT_DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(firstResult?.frames).toEqual([]);
    expect(secondResult?.frames).toEqual([]);
    expect(firstResult?.fingerprint).toBe(secondResult?.fingerprint);
    expect(firstResult?.error.stack).toBe("Error: persistence_failure");
    expect(secondResult?.error.stack).toBe("Error: persistence_failure");
  });

  it("classifies global-install project frames before generic dependency frames", () => {
    const globalRoot = "/usr/local/lib/node_modules/@timo972/cc-router";
    const error = new Error("PRIVATE_GLOBAL_INSTALL");
    error.stack = [
      "Error: PRIVATE_GLOBAL_INSTALL",
      `    at start (${globalRoot}/dist/cli/index.js:12:4)`,
      `    at dependency (${globalRoot}/node_modules/chalk/source/index.js:20:6)`,
    ].join("\n");

    const result = sanitizeException(error, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, { projectRoot: globalRoot });

    expect(result?.frames).toEqual([
      { path: "dist/cli/index.js", line: 12, column: 4 },
      { path: "node_modules/chalk/source/index.js", line: 20, column: 6 },
    ]);
  });

  it("drops unrelated absolute dist roots and strips trusted-root UUID canaries", () => {
    const rootCanary = "c58fcf9c-63ec-44a6-ac1f-6dc741bd2f69";
    const unrelatedCanary = "e51a3bc5-19c2-42de-b770-3fd43a2d93ee";
    const trustedRoot = `/private/${rootCanary}/cc-router`;
    const error = new Error("PRIVATE_ROOT_CLASSIFICATION");
    error.stack = [
      "Error: PRIVATE_ROOT_CLASSIFICATION",
      `    at trusted (${trustedRoot}/dist/server/index.js:31:7)`,
      `    at unrelated (/srv/${unrelatedCanary}/dist/injected.js:5:4)`,
    ].join("\n");

    const result = sanitizeException(error, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, { projectRoot: trustedRoot });

    expect(result?.frames).toEqual([
      { path: "dist/server/index.js", line: 31, column: 7 },
    ]);
    expect(result?.error.stack).not.toContain(rootCanary);
    expect(result?.error.stack).not.toContain(unrelatedCanary);
    expect(JSON.stringify(result)).not.toContain(rootCanary);
    expect(JSON.stringify(result)).not.toContain(unrelatedCanary);
  });

  it("drops project frames with UUID-shaped retained path segments from output and grouping", () => {
    const firstUuid = "dd934345-a43a-4f98-844e-bd14d8080e9f";
    const secondUuid = "3ae28467-dfd0-4f91-9998-c592ea0e2e7d";
    const first = new Error("PRIVATE_PROJECT_UUID_A");
    first.stack = [
      "Error: PRIVATE_PROJECT_UUID_A",
      `    at run (${PROJECT_ROOT}/dist/${firstUuid}/run.js:17:3)`,
    ].join("\n");
    const second = new Error("PRIVATE_PROJECT_UUID_B");
    second.stack = [
      "Error: PRIVATE_PROJECT_UUID_B",
      `    at run (${PROJECT_ROOT}/dist/${secondUuid}/run.js:17:3)`,
    ].join("\n");

    const firstResult = sanitizeException(first, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const secondResult = sanitizeException(second, context, {
      installationId: INSTALL_ID,
      diagnosticId: NEXT_DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(firstResult?.frames).toEqual([]);
    expect(secondResult?.frames).toEqual([]);
    expect(firstResult?.fingerprint).toBe(secondResult?.fingerprint);
    for (const canary of [firstUuid, secondUuid]) {
      expect(firstResult?.error.stack).not.toContain(canary);
      expect(secondResult?.error.stack).not.toContain(canary);
      expect(JSON.stringify(firstResult)).not.toContain(canary);
      expect(JSON.stringify(secondResult)).not.toContain(canary);
    }
  });

  it("drops dependency frames with UUID-shaped retained path segments from output and grouping", () => {
    const firstUuid = "6440847e-8ad3-484c-a759-684eadfed32c";
    const secondUuid = "F43DDC3D-4CB8-46CC-9368-841245BE97EB";
    const first = new Error("PRIVATE_DEPENDENCY_UUID_A");
    first.stack = [
      "Error: PRIVATE_DEPENDENCY_UUID_A",
      `    at load (${PROJECT_ROOT}/node_modules/safe-package/cache/${firstUuid}/index.js:9:2)`,
    ].join("\n");
    const second = new Error("PRIVATE_DEPENDENCY_UUID_B");
    second.stack = [
      "Error: PRIVATE_DEPENDENCY_UUID_B",
      `    at load (${PROJECT_ROOT}/node_modules/safe-package/cache/${secondUuid}/index.js:9:2)`,
    ].join("\n");

    const firstResult = sanitizeException(first, context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);
    const secondResult = sanitizeException(second, context, {
      installationId: INSTALL_ID,
      diagnosticId: NEXT_DIAGNOSTIC_ID,
    }, TRUSTED_SOURCE);

    expect(firstResult?.frames).toEqual([]);
    expect(secondResult?.frames).toEqual([]);
    expect(firstResult?.fingerprint).toBe(secondResult?.fingerprint);
    for (const canary of [firstUuid, secondUuid]) {
      expect(firstResult?.error.stack).not.toContain(canary);
      expect(secondResult?.error.stack).not.toContain(canary);
      expect(JSON.stringify(firstResult)).not.toContain(canary);
      expect(JSON.stringify(secondResult)).not.toContain(canary);
    }
  });

  it.each([
    undefined,
    { projectRoot: "relative/cc-router" },
    { projectRoot: "file:///Users/alice/work/cc-router" },
    { projectRoot: "/Users/alice/work/cc-router/../other" },
  ])("fails closed without a valid absolute trusted project root", (trustedSource) => {
    expect(sanitizeException(new Error("PRIVATE"), context, {
      installationId: INSTALL_ID,
      diagnosticId: DIAGNOSTIC_ID,
    }, trustedSource)).toBeUndefined();
  });
});
