import { describe, it, expect } from "vitest";
import { createRateLimiter, DEFAULT_RATE_LIMITS } from "./rate-limiter.js";

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
