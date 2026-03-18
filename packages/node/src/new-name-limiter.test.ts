import { describe, it, expect } from "vitest";
import { createNewNameLimiter } from "./new-name-limiter.js";

describe("NewNameLimiter", () => {
  it("admits names up to the limit", () => {
    const limiter = createNewNameLimiter(3);
    expect(limiter.tryAdmit(1000)).toBe(true);
    expect(limiter.tryAdmit(2000)).toBe(true);
    expect(limiter.tryAdmit(3000)).toBe(true);
    expect(limiter.tryAdmit(4000)).toBe(false);
  });

  it("rejects after limit is reached", () => {
    const limiter = createNewNameLimiter(2);
    limiter.tryAdmit(1000);
    limiter.tryAdmit(2000);
    expect(limiter.tryAdmit(3000)).toBe(false);
    expect(limiter.tryAdmit(4000)).toBe(false);
  });

  it("admits again after window expires", () => {
    const limiter = createNewNameLimiter(2);
    const hour = 3_600_000;
    limiter.tryAdmit(1000);
    limiter.tryAdmit(2000);
    expect(limiter.tryAdmit(3000)).toBe(false);

    // After 1 hour, oldest entries expire
    expect(limiter.tryAdmit(1000 + hour + 1)).toBe(true);
  });

  it("tracks metrics correctly", () => {
    const limiter = createNewNameLimiter(1);
    limiter.tryAdmit(1000);
    limiter.tryAdmit(2000);
    limiter.tryAdmit(3000);
    const m = limiter.metrics();
    expect(m.admitted).toBe(1);
    expect(m.rejected).toBe(2);
  });

  it("sliding window drops oldest entries", () => {
    const limiter = createNewNameLimiter(2);
    const hour = 3_600_000;
    // Fill at t=0 and t=100
    limiter.tryAdmit(0);
    limiter.tryAdmit(100);
    expect(limiter.tryAdmit(200)).toBe(false);

    // At t=hour+1, the t=0 entry expires but t=100
    // is still in window — only 1 slot free
    expect(limiter.tryAdmit(hour + 1)).toBe(true);
    expect(limiter.tryAdmit(hour + 2)).toBe(false);

    // At t=hour+101, the t=100 entry also expires
    expect(limiter.tryAdmit(hour + 101)).toBe(true);
  });

  it("handles limit of 0 (reject all)", () => {
    const limiter = createNewNameLimiter(0);
    expect(limiter.tryAdmit(1000)).toBe(false);
  });
});
