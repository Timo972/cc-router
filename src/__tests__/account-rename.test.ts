import { describe, expect, it, vi } from "vitest";
import {
  AccountRenameConflictError,
  isValidAccountId,
  renameAccountTransaction,
} from "../proxy/account-rename.js";

describe("isValidAccountId", () => {
  it("accepts the shapes existing account ids use", () => {
    expect(isValidAccountId("max-developer-droidrun")).toBe(true);
    expect(isValidAccountId("pro.timo_personal")).toBe(true);
    expect(isValidAccountId("a")).toBe(true);
  });

  it("rejects anything that would break URLs, files, or columns", () => {
    expect(isValidAccountId("")).toBe(false);
    expect(isValidAccountId("has space")).toBe(false);
    expect(isValidAccountId("-leading-dash")).toBe(false);
    expect(isValidAccountId("a/b")).toBe(false);
    expect(isValidAccountId("x".repeat(65))).toBe(false);
    expect(isValidAccountId(42)).toBe(false);
    expect(isValidAccountId(undefined)).toBe(false);
  });
});

function makePorts() {
  return {
    rename: vi.fn().mockReturnValue(true),
    renameSessions: vi.fn(),
    persist: vi.fn(),
  };
}

describe("renameAccountTransaction", () => {
  it("renames, migrates sessions, and persists", () => {
    const ports = makePorts();
    const outcome = renameAccountTransaction("old", "new", new Set(["old", "other"]), ports);

    expect(outcome).toBe("renamed");
    expect(ports.rename).toHaveBeenCalledWith("old", "new");
    expect(ports.renameSessions).toHaveBeenCalledWith("old", "new");
    expect(ports.persist).toHaveBeenCalledTimes(1);
  });

  it("treats renaming to the same id as a successful no-op", () => {
    const ports = makePorts();
    const outcome = renameAccountTransaction("same", "same", new Set(["same"]), ports);

    expect(outcome).toBe("renamed");
    expect(ports.rename).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it("rejects a taken id before touching any state", () => {
    const ports = makePorts();
    expect(() => renameAccountTransaction("old", "other", new Set(["old", "other"]), ports))
      .toThrow(AccountRenameConflictError);
    expect(ports.rename).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it("reports not_found without persisting when the pool does not know the id", () => {
    const ports = makePorts();
    ports.rename.mockReturnValue(false);

    expect(renameAccountTransaction("missing", "new", new Set(), ports)).toBe("not_found");
    expect(ports.renameSessions).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it("rolls the rename back when persistence fails", () => {
    const ports = makePorts();
    ports.persist.mockImplementation(() => { throw new Error("disk full"); });

    expect(() => renameAccountTransaction("old", "new", new Set(["old"]), ports))
      .toThrow("disk full");
    // Runtime state must match what is actually on disk — the old id.
    expect(ports.rename).toHaveBeenNthCalledWith(2, "new", "old");
    expect(ports.renameSessions).toHaveBeenNthCalledWith(2, "new", "old");
  });
});
