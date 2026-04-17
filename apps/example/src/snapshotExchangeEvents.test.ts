import { describe, expect, it } from "vitest";
import {
  formatAgo,
  pushEvent,
  type ExchangeEvent,
} from "./snapshotExchangeEvents";

function evt(seq: number, ts: number = seq * 1000): ExchangeEvent {
  return {
    seq,
    kind: "catalog",
    ts,
    detail: "1 entry",
  };
}

describe("pushEvent", () => {
  it("prepends to an empty buffer", () => {
    const out = pushEvent([], evt(1), 5);
    expect(out).toEqual([evt(1)]);
  });

  it("places newest first (chronological-reverse)", () => {
    const a = evt(1);
    const b = evt(2);
    const buf = pushEvent([], a, 5);
    const next = pushEvent(buf, b, 5);
    expect(next.map((e) => e.seq)).toEqual([2, 1]);
  });

  it("evicts the oldest entry once at capacity", () => {
    let buf: ExchangeEvent[] = [];
    for (let i = 1; i <= 4; i++) buf = pushEvent(buf, evt(i), 3);
    // After 4 pushes with size=3 we expect newest 3:
    // [4, 3, 2]; the oldest (seq=1) was evicted.
    expect(buf.map((e) => e.seq)).toEqual([4, 3, 2]);
    expect(buf.length).toBe(3);
  });

  it("never exceeds the configured size", () => {
    let buf: ExchangeEvent[] = [];
    for (let i = 1; i <= 50; i++) buf = pushEvent(buf, evt(i), 20);
    expect(buf.length).toBe(20);
    expect(buf[0]!.seq).toBe(50);
    expect(buf[buf.length - 1]!.seq).toBe(31);
  });

  it("does not mutate the input buffer (pure)", () => {
    const buf = [evt(1)];
    const snapshot = [...buf];
    pushEvent(buf, evt(2), 5);
    expect(buf).toEqual(snapshot);
  });
});

describe("formatAgo", () => {
  it("formats sub-minute ages in seconds", () => {
    const now = 100_000;
    expect(formatAgo(now - 5_000, now)).toBe("5s ago");
  });

  it("formats sub-hour ages in minutes", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 3 * 60_000, now)).toBe("3m ago");
  });

  it("formats hour+ ages in hours", () => {
    const now = 10_000_000;
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe("2h ago");
  });

  it("clamps a future timestamp to 0s ago (no negatives)", () => {
    const now = 1_000;
    // A clock skew where event ts > now should still
    // render sanely rather than "-3s ago".
    expect(formatAgo(now + 3_000, now)).toBe("0s ago");
  });
});
