import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  acquireRequestRoute,
  applyUpstreamFailureRouting,
  attachLeaseLifecycle,
  routeReasonDetails,
} from "../proxy/lease-lifecycle.js";

describe("attachLeaseLifecycle", () => {
  it.each(["finish", "close"] as const)("releases once on downstream %s", (event) => {
    const response = new EventEmitter();
    const release = vi.fn();
    attachLeaseLifecycle(response, { release });

    response.emit(event);
    response.emit("finish");
    response.emit("close");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["proxy error", "refresh/pre-forward failure"])(
    "shares one-shot release with explicit %s cleanup",
    () => {
      const response = new EventEmitter();
      const release = vi.fn();
      const cleanup = attachLeaseLifecycle(response, { release });

      cleanup();
      cleanup();
      response.emit("finish");
      response.emit("close");

      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps explicit proxy-error cleanup safe after downstream close", () => {
    const response = new EventEmitter();
    const release = vi.fn();
    const cleanup = attachLeaseLifecycle(response, { release });

    response.emit("close");
    cleanup();
    response.emit("finish");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("routeReasonDetails", () => {
  it("records only the bounded routing reason, never the session identifier", () => {
    const details = routeReasonDetails({
      reason: "sticky",
      sessionId: "private-session-value",
    });

    expect(details).toBe("sticky");
    expect(details).not.toContain("private-session-value");
  });

  it("acquires the session route, attaches cleanup, and returns only reason details", () => {
    const response = new EventEmitter();
    const route = {
      account: { id: "account-a" },
      reason: "new-session" as const,
      sessionId: "private-session-value",
      release: vi.fn(),
    };
    const acquire = vi.fn().mockReturnValue(route);

    const selected = acquireRequestRoute(
      "private-session-value",
      response,
      { acquire },
    );

    expect(acquire).toHaveBeenCalledWith("private-session-value");
    expect(selected.route).toBe(route);
    expect(selected.details).toBe("new-session");
    expect(selected.details).not.toContain("private-session-value");
    selected.release();
    response.emit("close");
    expect(route.release).toHaveBeenCalledTimes(1);
  });
});

describe("applyUpstreamFailureRouting", () => {
  const route = {
    account: { id: "account-a" },
    sessionId: "session-a",
  };

  it("invalidates the matching binding on 401 without applying a cooldown", () => {
    const invalidate = vi.fn();
    const setCooldown = vi.fn();

    expect(applyUpstreamFailureRouting(401, undefined, route, { invalidate }, { setCooldown }))
      .toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a");
    expect(setCooldown).not.toHaveBeenCalled();
  });

  it("invalidates and applies a numeric Retry-After cooldown on 429", () => {
    const invalidate = vi.fn();
    const setCooldown = vi.fn();

    expect(applyUpstreamFailureRouting(429, "12.5", route, { invalidate }, { setCooldown }))
      .toBe(12.5);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a");
    expect(setCooldown).toHaveBeenCalledWith("account-a", 12_500);
  });

  it.each([undefined, "not-a-number", "-1", "Infinity", ["1", "2"]])(
    "uses the 60-second 429 fallback for an unsafe Retry-After value %j",
    (retryAfter) => {
      const invalidate = vi.fn();
      const setCooldown = vi.fn();

      expect(applyUpstreamFailureRouting(429, retryAfter, route, { invalidate }, { setCooldown }))
        .toBe(60);
      expect(setCooldown).toHaveBeenCalledWith("account-a", 60_000);
    },
  );

  it("accepts a finite zero-second Retry-After value", () => {
    const invalidate = vi.fn();
    const setCooldown = vi.fn();

    expect(applyUpstreamFailureRouting(429, "0", route, { invalidate }, { setCooldown }))
      .toBe(0);
    expect(setCooldown).toHaveBeenCalledWith("account-a", 0);
  });

  it("invalidates and applies the fixed 30-second cooldown on 529", () => {
    const invalidate = vi.fn();
    const setCooldown = vi.fn();

    expect(applyUpstreamFailureRouting(529, "900", route, { invalidate }, { setCooldown }))
      .toBe(30);
    expect(invalidate).toHaveBeenCalledWith("session-a", "account-a");
    expect(setCooldown).toHaveBeenCalledWith("account-a", 30_000);
  });

  it("does not mutate routing for successful responses", () => {
    const invalidate = vi.fn();
    const setCooldown = vi.fn();

    expect(applyUpstreamFailureRouting(200, undefined, route, { invalidate }, { setCooldown }))
      .toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
    expect(setCooldown).not.toHaveBeenCalled();
  });
});
