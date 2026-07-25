import { describe, it, expect } from "vitest";
import { isValidVersion } from "../utils/self-update.js";

describe("isValidVersion", () => {
  it("accepts clean semver", () => {
    expect(isValidVersion("0.6.2")).toBe(true);
    expect(isValidVersion("1.0.0")).toBe(true);
    expect(isValidVersion("12.34.56")).toBe(true);
    expect(isValidVersion("1.2.3-beta.1")).toBe(true);
    expect(isValidVersion("1.2.3+build.5")).toBe(true);
  });

  it("rejects command-injection payloads in the version string", () => {
    // These are the values that must never reach `npm install ai-cc-router@<v>`
    // — especially on Windows where spawn used to run through cmd.exe.
    expect(isValidVersion("1.0.0 & calc.exe")).toBe(false);
    expect(isValidVersion("1.0.0 && powershell -e ...")).toBe(false);
    expect(isValidVersion("1.0.0; rm -rf /")).toBe(false);
    expect(isValidVersion("$(whoami)")).toBe(false);
    expect(isValidVersion("`id`")).toBe(false);
    expect(isValidVersion("1.0.0\nmalicious")).toBe(false);
    expect(isValidVersion("../../evil")).toBe(false);
  });

  it("rejects non-strings and malformed versions", () => {
    expect(isValidVersion(undefined)).toBe(false);
    expect(isValidVersion(null)).toBe(false);
    expect(isValidVersion(123)).toBe(false);
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("1.2")).toBe(false);
    expect(isValidVersion("latest")).toBe(false);
    expect(isValidVersion("v1.2.3")).toBe(false);
  });
});
