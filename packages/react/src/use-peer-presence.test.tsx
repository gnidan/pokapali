import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePeerPresenceState } from "./use-peer-presence.js";
import type { Doc, DocStatus, ParticipantInfo } from "@pokapali/core";
import type { Feed } from "@pokapali/core";

interface WritableFeed<T> extends Feed<T> {
  _update(value: T): void;
}

function createFeed<T>(initial: T): WritableFeed<T> {
  let current = initial;
  const subs = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    _update(value: T) {
      current = value;
      for (const cb of subs) cb();
    },
  };
}

type ChangeHandler = () => void;

interface MockDoc {
  doc: Doc;
  statusFeed: WritableFeed<DocStatus>;
  fire: () => void;
  setParticipants: (map: ReadonlyMap<number, ParticipantInfo>) => void;
}

function mockDoc(options?: {
  initialStatus?: DocStatus;
  initialParticipants?: ReadonlyMap<number, ParticipantInfo>;
  clientID?: number;
}): MockDoc {
  const {
    initialStatus = "connecting" as DocStatus,
    initialParticipants = new Map<number, ParticipantInfo>(),
    clientID = 1,
  } = options ?? {};

  const statusFeed = createFeed<DocStatus>(initialStatus);
  const listeners: ChangeHandler[] = [];
  let currentParticipants = initialParticipants;

  const doc = {
    status: statusFeed,
    get participants() {
      return currentParticipants;
    },
    awareness: {
      clientID,
      on(_event: string, cb: ChangeHandler) {
        listeners.push(cb);
      },
      off(_event: string, cb: ChangeHandler) {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    },
  } as unknown as Doc;

  return {
    doc,
    statusFeed,
    fire() {
      for (const cb of listeners) cb();
    },
    setParticipants(map: ReadonlyMap<number, ParticipantInfo>) {
      currentParticipants = map;
    },
  };
}

describe("usePeerPresenceState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in connecting state", () => {
    const { doc } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    expect(result.current.state).toBe("connecting");
    expect(result.current.peerCount).toBe(0);
    expect(result.current.label).toBe("Connecting\u2026");
  });

  it("transitions to looking when connected with no peers", () => {
    const { doc, statusFeed } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    expect(result.current.state).toBe("looking");
    expect(result.current.label).toBe("Looking for peers\u2026");
  });

  it("transitions to active when peers appear", () => {
    const { doc, statusFeed, fire, setParticipants } = mockDoc({ clientID: 1 });

    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    const peers = new Map<number, ParticipantInfo>([
      [1, { pubkey: "self" }],
      [2, { pubkey: "peer" }],
    ]);
    act(() => {
      setParticipants(peers);
      fire();
    });

    expect(result.current.state).toBe("active");
    expect(result.current.peerCount).toBe(1);
    expect(result.current.label).toBe("1 user editing");
  });

  it("shows correct label for multiple peers", () => {
    const { doc, statusFeed, fire, setParticipants } = mockDoc({ clientID: 1 });

    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    const peers = new Map<number, ParticipantInfo>([
      [1, { pubkey: "self" }],
      [2, { pubkey: "peer-a" }],
      [3, { pubkey: "peer-b" }],
    ]);
    act(() => {
      setParticipants(peers);
      fire();
    });

    expect(result.current.peerCount).toBe(2);
    expect(result.current.label).toBe("2 users editing");
  });

  it("excludes self from peer count", () => {
    const { doc, statusFeed, fire, setParticipants } = mockDoc({ clientID: 5 });

    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    // Only self in participants
    const selfOnly = new Map<number, ParticipantInfo>([
      [5, { pubkey: "self" }],
    ]);
    act(() => {
      setParticipants(selfOnly);
      fire();
    });

    expect(result.current.peerCount).toBe(0);
    expect(result.current.state).toBe("looking");
  });

  it("settles to 'Just you' after 5s with no peers", () => {
    const { doc, statusFeed } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));
    expect(result.current.state).toBe("looking");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.state).toBe("active");
    expect(result.current.peerCount).toBe(0);
    expect(result.current.label).toBe("Just you");
  });

  it("does not settle before 5s", () => {
    const { doc, statusFeed } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    act(() => {
      vi.advanceTimersByTime(4_999);
    });

    expect(result.current.state).toBe("looking");
  });

  it("resets settling timer when peers appear then leave", () => {
    const { doc, statusFeed, fire, setParticipants } = mockDoc({ clientID: 1 });

    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("synced"));

    // Advance 3s into settling
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.state).toBe("looking");

    // Peer appears — resets settling
    const withPeer = new Map<number, ParticipantInfo>([
      [1, { pubkey: "self" }],
      [2, { pubkey: "peer" }],
    ]);
    act(() => {
      setParticipants(withPeer);
      fire();
    });
    expect(result.current.state).toBe("active");

    // Peer leaves
    const noPeer = new Map<number, ParticipantInfo>([[1, { pubkey: "self" }]]);
    act(() => {
      setParticipants(noPeer);
      fire();
    });
    expect(result.current.state).toBe("looking");

    // Only 3s after peer left — still looking
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.state).toBe("looking");

    // Full 5s after peer left — settles
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.state).toBe("active");
    expect(result.current.label).toBe("Just you");
  });

  it("shows reconnecting after connection drops", () => {
    const { doc, statusFeed } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    // Connect first
    act(() => statusFeed._update("synced"));
    expect(result.current.state).toBe("looking");

    // Connection drops
    act(() => statusFeed._update("offline"));

    expect(result.current.state).toBe("reconnecting");
    expect(result.current.label).toBe("Reconnecting\u2026");
  });

  it("stays connecting if never connected", () => {
    const { doc, statusFeed } = mockDoc({
      initialStatus: "connecting",
    });
    const { result } = renderHook(() => usePeerPresenceState(doc));

    // Go offline without ever being connected
    act(() => statusFeed._update("offline"));

    expect(result.current.state).toBe("connecting");
  });

  it("treats receiving as connected", () => {
    const { doc, statusFeed } = mockDoc();
    const { result } = renderHook(() => usePeerPresenceState(doc));

    act(() => statusFeed._update("receiving"));

    expect(result.current.state).toBe("looking");
  });

  it("resets to connecting when doc changes", () => {
    const mock1 = mockDoc();
    const mock2 = mockDoc();

    let currentDoc = mock1.doc;
    const { result, rerender } = renderHook(() =>
      usePeerPresenceState(currentDoc),
    );

    // First doc connects then drops
    act(() => mock1.statusFeed._update("synced"));
    act(() => mock1.statusFeed._update("offline"));
    expect(result.current.state).toBe("reconnecting");

    // Swap to second doc (never connected)
    currentDoc = mock2.doc;
    rerender();

    expect(result.current.state).toBe("connecting");
  });
});
