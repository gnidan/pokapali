import { describe, it, expect } from "vitest";
import { nextPublishedTs } from "./lastPublished";

describe("nextPublishedTs", () => {
  it("advances to a newer event timestamp", () => {
    const prev = 1_000;
    const newer = 2_000;
    expect(nextPublishedTs(prev, newer)).toBe(newer);
  });

  it("ignores an older event timestamp (out-of-order historical event)", () => {
    // Late joiner scenario: prev was set at mount
    // time (T2) and a peer delivers a historical
    // snapshot with ts=T1 < T2. Without Math.max,
    // lastPublished would regress to T1, causing
    // "last updated" to show stale content as "just
    // now."
    const prev = 2_000;
    const older = 1_000;
    expect(nextPublishedTs(prev, older)).toBe(prev);
  });

  it("is idempotent for equal timestamps", () => {
    const ts = 1_000;
    expect(nextPublishedTs(ts, ts)).toBe(ts);
  });
});
