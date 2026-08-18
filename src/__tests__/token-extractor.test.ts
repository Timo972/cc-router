import { describe, it, expect, vi, afterEach } from "vitest";

// Mock fs before importing the module under test
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import {
  extractFromCredentialsFile,
  extractFromCredentialsFileDetailed,
  extractFromKeychainDetailed,
  formatExpiry,
  redactToken,
} from "../utils/token-extractor.js";
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

describe("typed credential extraction", () => {
  it("distinguishes missing, unreadable, and malformed credential files without exporting local detail", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(extractFromCredentialsFileDetailed()).toEqual({
      ok: false,
      error: expect.objectContaining({
        classification: {
          stage: "credential_read",
          reason: "not_found",
          expected: true,
        },
      }),
    });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("/Users/private/.claude/.credentials.json PRIVATE"), { code: "EACCES" });
    });
    const denied = extractFromCredentialsFileDetailed();
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.message).toContain("PRIVATE");
      expect(denied.error.classification).toEqual({
        stage: "credential_read",
        reason: "permission_denied",
        expected: true,
      });
      expect(JSON.stringify(denied.error.classification)).not.toContain("PRIVATE");
    }

    vi.mocked(fs.readFileSync).mockReturnValue("PRIVATE malformed {{{");
    const malformed = extractFromCredentialsFileDetailed();
    expect(malformed).toEqual({
      ok: false,
      error: expect.objectContaining({
        classification: {
          stage: "credential_parse",
          reason: "malformed_credentials",
          expected: true,
        },
      }),
    });
  });

  it("classifies Keychain read and parse failures at their origin", async () => {
    const denied = await extractFromKeychainDetailed({
      readCredential: async () => {
        throw Object.assign(new Error("PRIVATE keychain path"), { code: "EPERM" });
      },
    });
    expect(denied).toEqual({
      ok: false,
      error: expect.objectContaining({
        classification: {
          stage: "credential_read",
          reason: "permission_denied",
          expected: true,
        },
      }),
    });

    const malformed = await extractFromKeychainDetailed({
      readCredential: async () => "PRIVATE not-json",
    });
    expect(malformed).toEqual({
      ok: false,
      error: expect.objectContaining({
        classification: {
          stage: "credential_parse",
          reason: "malformed_credentials",
          expected: true,
        },
      }),
    });
  });

  it("returns completed read/parse stages only with valid credentials", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "sk-ant-oat01-valid",
      refreshToken: "sk-ant-ort01-valid",
      expiresAt: 1999999999000,
    }));

    expect(extractFromCredentialsFileDetailed()).toEqual({
      ok: true,
      tokens: expect.objectContaining({ accessToken: "sk-ant-oat01-valid" }),
      completedStages: ["credential_read", "credential_parse"],
    });
  });

  it("rejects invalid expiry and scope shapes as malformed credentials", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      accessToken: "sk-ant-oat01-valid",
      refreshToken: "sk-ant-ort01-valid",
      expiresAt: "not-a-date",
      scopes: ["user:inference", { private: "PRIVATE" }],
    }));

    const result = extractFromCredentialsFileDetailed();

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        classification: {
          stage: "credential_parse",
          reason: "malformed_credentials",
          expected: true,
        },
      }),
    });
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
