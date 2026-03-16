import { describe, it, expect } from "vitest";
import {
  PokapaliError,
  PermissionError,
  TimeoutError,
  DestroyedError,
  ValidationError,
  NotFoundError,
} from "./errors.js";

describe("error classes", () => {
  it("PokapaliError is instanceof Error", () => {
    const e = new PokapaliError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PokapaliError);
    expect(e.name).toBe("PokapaliError");
    expect(e.message).toBe("test");
  });

  const subclasses = [
    ["PermissionError", PermissionError],
    ["TimeoutError", TimeoutError],
    ["DestroyedError", DestroyedError],
    ["ValidationError", ValidationError],
    ["NotFoundError", NotFoundError],
  ] as const;

  for (const [name, Cls] of subclasses) {
    it(`${name} extends PokapaliError`, () => {
      const e = new Cls("msg");
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(PokapaliError);
      expect(e).toBeInstanceOf(Cls);
      expect(e.name).toBe(name);
      expect(e.message).toBe("msg");
    });
  }

  it("instanceof distinguishes subclasses", () => {
    const perm = new PermissionError("no");
    const timeout = new TimeoutError("slow");
    expect(perm).not.toBeInstanceOf(TimeoutError);
    expect(timeout).not.toBeInstanceOf(PermissionError);
    // both are PokapaliError
    expect(perm).toBeInstanceOf(PokapaliError);
    expect(timeout).toBeInstanceOf(PokapaliError);
  });
});
