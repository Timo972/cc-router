import { afterEach, describe, expect, it } from "vitest";
import {
  assertLoopbackUrl,
  startTransportCaptureServer,
  type TransportCaptureServer,
} from "./telemetry-test-helpers.js";

describe("telemetry transport capture endpoints", () => {
  let capture: TransportCaptureServer | undefined;

  afterEach(async () => {
    await capture?.close();
  });

  it("rejects localhost and external hosts but accepts emitted literal loopback endpoints", async () => {
    capture = await startTransportCaptureServer();

    expect(() => assertLoopbackUrl("http://localhost:4318/v1/traces")).toThrow(/loopback/);
    expect(() => assertLoopbackUrl("https://telemetry.example.test/v1/traces")).toThrow(/loopback/);
    expect(assertLoopbackUrl(capture.endpoint("/v1/traces")).hostname).toBe("127.0.0.1");
  });
});
