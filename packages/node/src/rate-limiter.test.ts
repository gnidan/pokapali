import { describe, it, expect } from "vitest";
import { createRateLimiter, createIpRateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  it("allows snapshots within limits", () => {
    const limiter = createRateLimiter();
    const result = limiter.check("name1", 1000);
    expect(result.allowed).toBe(true);
  });

  it("rejects oversized blocks", () => {
    const limiter = createRateLimiter({
      maxSnapshotsPerHour: 60,
      maxBlockSizeBytes: 100,
    });
    const result = limiter.check("name1", 200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/block size/);
  });

  it("enforces per-hour rate limit", () => {
    const limiter = createRateLimiter({
      maxSnapshotsPerHour: 3,
      maxBlockSizeBytes: 5_000_000,
    });
    const now = 1_000_000;

    limiter.record("name1", now);
    limiter.record("name1", now + 1000);
    limiter.record("name1", now + 2000);

    const result = limiter.check("name1", 100, now + 3000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/rate limit/);
  });

  it("allows after old entries expire", () => {
    const limiter = createRateLimiter({
      maxSnapshotsPerHour: 2,
      maxBlockSizeBytes: 5_000_000,
    });
    const now = 1_000_000;

    limiter.record("name1", now);
    limiter.record("name1", now + 1000);

    // 1 hour + 1ms later
    const later = now + 3_600_001;
    const result = limiter.check("name1", 100, later);
    expect(result.allowed).toBe(true);
  });

  it("tracks names independently", () => {
    const limiter = createRateLimiter({
      maxSnapshotsPerHour: 1,
      maxBlockSizeBytes: 5_000_000,
    });
    const now = 1_000_000;

    limiter.record("name1", now);

    expect(limiter.check("name1", 100, now + 1).allowed).toBe(false);
    expect(limiter.check("name2", 100, now + 1).allowed).toBe(true);
  });
});

describe("IpRateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = createIpRateLimiter(3);
    const now = 1_000_000;
    expect(limiter.check("1.2.3.4", now)).toBe(true);
  });

  it("denies after exceeding rpm", () => {
    const limiter = createIpRateLimiter(2);
    const now = 1_000_000;
    limiter.record("1.2.3.4", now);
    limiter.record("1.2.3.4", now + 100);
    expect(limiter.check("1.2.3.4", now + 200)).toBe(false);
  });

  it("allows after window expires", () => {
    const limiter = createIpRateLimiter(1);
    const now = 1_000_000;
    limiter.record("1.2.3.4", now);
    // 60s + 1ms later
    expect(limiter.check("1.2.3.4", now + 60_001)).toBe(true);
  });

  it("tracks IPs independently", () => {
    const limiter = createIpRateLimiter(1);
    const now = 1_000_000;
    limiter.record("1.2.3.4", now);
    expect(limiter.check("1.2.3.4", now + 1)).toBe(false);
    expect(limiter.check("5.6.7.8", now + 1)).toBe(true);
  });
});
