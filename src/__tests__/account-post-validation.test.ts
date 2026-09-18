import { describe, expect, it } from "vitest";
import { validateAccountPostBody } from "../proxy/account-post-validation.js";

const base = { id: "a", accessToken: "sk-ant-oat01-x", expiresAt: 1_900_000_000_000 };

describe("validateAccountPostBody", () => {
  it("accepts an anthropic record without a refreshToken", () => {
    const result = validateAccountPostBody(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.refreshToken).toBeUndefined();
      expect(result.body.replace).toBe(false);
    }
  });

  it("rejects an openai record without a refreshToken", () => {
    const result = validateAccountPostBody({ ...base, provider: "openai_subscription" });
    expect(result).toEqual({ ok: false, status: 400, error: "Missing required field: refreshToken" });
  });

  it("rejects an anthropic record whose refreshToken is not a string", () => {
    expect(validateAccountPostBody({ ...base, refreshToken: 5 }).ok).toBe(false);
  });

  it("rejects missing id / accessToken / expiresAt", () => {
    expect(validateAccountPostBody({ ...base, id: "" })).toMatchObject({ ok: false, error: "Missing required field: id" });
    expect(validateAccountPostBody({ ...base, accessToken: undefined })).toMatchObject({ ok: false, error: "Missing required field: accessToken" });
    expect(validateAccountPostBody({ ...base, expiresAt: "soon" })).toMatchObject({ ok: false, error: "Invalid field types on account record" });
  });

  it("reads the replace flag", () => {
    const result = validateAccountPostBody({ ...base, replace: true });
    expect(result.ok && result.body.replace).toBe(true);
  });
});
