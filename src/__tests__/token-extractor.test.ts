import { describe, it, expect, vi, afterEach } from "vitest";

// Mock fs before importing the module under test
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { extractFromCredentialsFile, formatExpiry, redactToken } from "../utils/token-extractor.js";
import * as fs from "fs";

afterEach(() => {
  vi.resetAllMocks();
});

// ─── extractFromCredentialsFile ───────────────────────────────────────────────

describe("extractFromCredentialsFile", () => {
  it("returns null when credentials file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(extractFromCredentialsFile()).toBeNull();
  });

  it("parses the claudeAiOauth nested format", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-abc123",
        refreshToken: "sk-ant-ort01-xyz789",
        expiresAt: 1999999999000,
        scopes: ["user:inference", "user:profile"],
      },
    }));

    const tokens = extractFromCredentialsFile();
    expect(tokens?.accessToken).toBe("sk-ant-oat01-abc123");
    expect(tokens?.refreshToken).toBe("sk-ant-ort01-xyz789");
    expect(tokens?.expiresAt).toBe(1999999999000);
    expect(tokens?.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("parses the direct flat format (no claudeAiOauth wrapper)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "sk-ant-oat01-direct",
      refreshToken: "sk-ant-ort01-direct",
      expiresAt: 1999999999000,
      scopes: ["user:inference"],
    }));

    const tokens = extractFromCredentialsFile();
    expect(tokens?.accessToken).toBe("sk-ant-oat01-direct");
  });

  it("converts ISO date string expiresAt to numeric timestamp", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-iso",
        refreshToken: "sk-ant-ort01-iso",
        expiresAt: "2026-04-04T06:23:45.000Z",
        scopes: ["user:inference", "user:profile"],
      },
    }));

    const tokens = extractFromCredentialsFile();
    expect(typeof tokens?.expiresAt).toBe("number");
    expect(tokens?.expiresAt).toBe(new Date("2026-04-04T06:23:45.000Z").getTime());
  });

  it("defaults to 8h expiry when expiresAt is missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "sk-ant-oat01-noexpiry",
      refreshToken: "sk-ant-ort01-noexpiry",
      // no expiresAt
    }));

    const tokens = extractFromCredentialsFile();
    const eightHoursMs = 8 * 60 * 60 * 1000;
    expect(tokens?.expiresAt).toBeGreaterThan(Date.now() + eightHoursMs - 5_000);
    expect(tokens?.expiresAt).toBeLessThan(Date.now() + eightHoursMs + 5_000);
  });

  it("defaults scopes when missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "sk-ant-oat01-noscopes",
      refreshToken: "sk-ant-ort01-noscopes",
      expiresAt: 1999999999000,
    }));

    const tokens = extractFromCredentialsFile();
    expect(tokens?.scopes).toEqual(["user:inference", "user:profile"]);
  });

  it("returns null when accessToken doesn't start with sk-ant-", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "invalid-token",
      refreshToken: "sk-ant-ort01-ok",
      expiresAt: 1999999999000,
    }));

    expect(extractFromCredentialsFile()).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json {{{{");

    expect(extractFromCredentialsFile()).toBeNull();
  });
});

// ─── formatExpiry ──────────────────────────────────────────────────────────────

describe("formatExpiry", () => {
  it("returns 'EXPIRED' for past timestamps", () => {
    expect(formatExpiry(Date.now() - 1_000)).toBe("EXPIRED");
  });

  it("formats minutes only for < 1h remaining", () => {
    const result = formatExpiry(Date.now() + 45 * 60 * 1000);
    expect(result).toMatch(/^\d+m$/);
  });

  it("formats hours and minutes for > 1h remaining", () => {
    const result = formatExpiry(Date.now() + 7 * 60 * 60 * 1000 + 30 * 60 * 1000);
    expect(result).toMatch(/^7h \d+m$/);
  });
});

// ─── redactToken ──────────────────────────────────────────────────────────────

describe("redactToken", () => {
  it("truncates tokens longer than 20 characters", () => {
    const token = "sk-ant-oat01-abcdefghijklmnop";
    const result = redactToken(token);
    expect(result).toBe("sk-ant-oat01-abcdefg...");
    expect(result.length).toBe(23); // 20 + "..."
  });

  it("returns short tokens unchanged", () => {
    const short = "sk-ant-short";
    expect(redactToken(short)).toBe(short);
  });
});
