import { describe, expect, it } from "vitest";
import { parseExpiryInput } from "../utils/expiry-input.js";

describe("parseExpiryInput", () => {
  it("reads a Unix millisecond timestamp as a number, not as a date string", () => {
    expect(parseExpiryInput("1790000000000")).toBe(1_790_000_000_000);
    expect(parseExpiryInput(" 1790000000000 ")).toBe(1_790_000_000_000);
  });

  it("reads an ISO date", () => {
    expect(parseExpiryInput("2027-01-01T00:00:00Z")).toBe(Date.parse("2027-01-01T00:00:00Z"));
    expect(parseExpiryInput("2027-01-01")).toBe(Date.parse("2027-01-01"));
  });

  it("rejects garbage, empty input and non-positive numbers", () => {
    expect(parseExpiryInput("soon")).toBeNull();
    expect(parseExpiryInput("")).toBeNull();
    expect(parseExpiryInput("0")).toBeNull();
    expect(parseExpiryInput("-5")).toBeNull();
    expect(parseExpiryInput("NaN")).toBeNull();
  });
});
