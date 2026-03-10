import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

vi.mock("./ipns-helpers.js", () => ({
  resolveIPNS: vi.fn().mockResolvedValue(null),
  watchIPNS: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("./announce.js", () => ({
  announceTopic: vi.fn(
    (appId: string) =>
      `/pokapali/app/${appId}/announce`,
  ),
  parseAnnouncement: vi.fn().mockReturnValue(null),
  announceSnapshot:
    vi.fn().mockResolvedValue(undefined),
}));

import {
  createSnapshotWatcher,
} from "./snapshot-watcher.js";
import {
  resolveIPNS,
  watchIPNS,
} from "./ipns-helpers.js";
import {
  announceTopic,
  parseAnnouncement,
  announceSnapshot,
} from "./announce.js";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

describe("createSnapshotWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to announce topic", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      onSnapshot: vi.fn(),
    });

    expect(pubsub.subscribe).toHaveBeenCalledWith(
      "/pokapali/app/test/announce",
    );

    watcher.destroy();
  });

  it("writers skip subscribe (already done)", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: true,
      onSnapshot: vi.fn(),
    });

    expect(
      pubsub.subscribe,
    ).not.toHaveBeenCalled();

    watcher.destroy();
  });

  it("starts IPNS polling", () => {
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      ipnsPublicKeyBytes: new Uint8Array(32),
      onSnapshot: vi.fn(),
    });

    expect(watchIPNS).toHaveBeenCalledTimes(1);

    watcher.destroy();
  });

  it("destroy cleans up", () => {
    const stopWatch = vi.fn();
    vi.mocked(watchIPNS).mockReturnValue(
      stopWatch,
    );
    const pubsub = {
      subscribe: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const helia = { blockstore: { get: vi.fn() } };

    const watcher = createSnapshotWatcher({
      appId: "test",
      ipnsName: "abc123",
      pubsub: pubsub as any,
      getHelia: () => helia as any,
      isWriter: false,
      ipnsPublicKeyBytes: new Uint8Array(32),
      onSnapshot: vi.fn(),
    });

    watcher.destroy();

    expect(stopWatch).toHaveBeenCalled();
    expect(
      pubsub.removeEventListener,
    ).toHaveBeenCalled();
  });

  describe("guaranteeUntil", () => {
    function makePubsub() {
      return {
        subscribe: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        publish:
          vi.fn().mockResolvedValue(undefined),
      };
    }

    function getMessageHandler(
      pubsub: ReturnType<typeof makePubsub>,
    ) {
      const call =
        pubsub.addEventListener.mock.calls.find(
          (c: any) => c[0] === "message",
        );
      return call?.[1] as (evt: any) => void;
    }

    function fakeAckEvent(
      topic: string,
      ipnsName: string,
      cid: string,
      peerId: string,
      guaranteeUntil?: number,
      retainUntil?: number,
    ) {
      const ack: any = { peerId };
      if (guaranteeUntil !== undefined) {
        ack.guaranteeUntil = guaranteeUntil;
      }
      if (retainUntil !== undefined) {
        ack.retainUntil = retainUntil;
      }
      vi.mocked(parseAnnouncement)
        .mockReturnValueOnce({
          ipnsName,
          cid,
          ack,
        });
      return {
        detail: {
          topic,
          data: new Uint8Array(),
        },
      };
    }

    it("null when no acks received", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      expect(watcher.guaranteeUntil).toBeNull();
      watcher.destroy();
    });

    it("stores guaranteeUntil from ack", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1700000000000,
      ));

      expect(
        watcher.guaranteeUntil,
      ).toBe(1700000000000);
      watcher.destroy();
    });

    it("takes max across multiple pinners", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1700000000000,
      ));
      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-B", 1800000000000,
      ));

      expect(
        watcher.guaranteeUntil,
      ).toBe(1800000000000);
      watcher.destroy();
    });

    it("monotonic per pinner (never decreases)", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1800000000000,
      ));
      // Lower value should not override
      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1700000000000,
      ));

      expect(
        watcher.guaranteeUntil,
      ).toBe(1800000000000);
      watcher.destroy();
    });

    it("clears on new CID tracking", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1700000000000,
      ));
      expect(
        watcher.guaranteeUntil,
      ).toBe(1700000000000);

      // New CID clears guarantees
      watcher.trackCidForAcks("cid-2");
      expect(watcher.guaranteeUntil).toBeNull();

      watcher.destroy();
    });

    it("null when ack has no guaranteeUntil", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      // Ack without guaranteeUntil
      handler(fakeAckEvent(
        topic, "abc", "cid-1", "pinner-A",
      ));

      expect(watcher.guaranteeUntil).toBeNull();
      watcher.destroy();
    });

    it("stores retainUntil from ack", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", undefined, 1700000000000,
      ));

      expect(
        watcher.retainUntil,
      ).toBe(1700000000000);
      expect(watcher.guaranteeUntil).toBeNull();
      watcher.destroy();
    });

    it("takes max retainUntil across pinners", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", undefined, 1700000000000,
      ));
      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-B", undefined, 1800000000000,
      ));

      expect(
        watcher.retainUntil,
      ).toBe(1800000000000);
      watcher.destroy();
    });

    it("tracks both guarantee and retain", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", 1700000000000, 1600000000000,
      ));

      expect(
        watcher.guaranteeUntil,
      ).toBe(1700000000000);
      expect(
        watcher.retainUntil,
      ).toBe(1600000000000);
      watcher.destroy();
    });

    it("clears retainUntil on new CID", () => {
      const pubsub = makePubsub();
      const watcher = createSnapshotWatcher({
        appId: "test",
        ipnsName: "abc",
        pubsub: pubsub as any,
        getHelia: () => ({} as any),
        isWriter: false,
        onSnapshot: vi.fn(),
      });

      watcher.trackCidForAcks("cid-1");
      const handler = getMessageHandler(pubsub);
      const topic =
        "/pokapali/app/test/announce";

      handler(fakeAckEvent(
        topic, "abc", "cid-1",
        "pinner-A", undefined, 1700000000000,
      ));
      expect(
        watcher.retainUntil,
      ).toBe(1700000000000);

      watcher.trackCidForAcks("cid-2");
      expect(watcher.retainUntil).toBeNull();
      watcher.destroy();
    });
  });

  describe("performInitialResolve", () => {
    async function fakeCid(
      seed: number,
    ): Promise<CID> {
      const hash = await sha256.digest(
        new Uint8Array([seed]),
      );
      return CID.createV1(0x71, hash);
    }

    it(
      "resolves IPNS and calls onSnapshot",
      async () => {
        const tipCid = await fakeCid(42);
        vi.mocked(resolveIPNS)
          .mockResolvedValue(tipCid);

        const onSnapshot =
          vi.fn().mockResolvedValue(undefined);
        const pubsub = {
          subscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          publish:
            vi.fn().mockResolvedValue(undefined),
        };
        const helia = {
          blockstore: { get: vi.fn() },
        };

        const watcher = createSnapshotWatcher({
          appId: "test",
          ipnsName: "abc123",
          pubsub: pubsub as any,
          getHelia: () => helia as any,
          isWriter: false,
          ipnsPublicKeyBytes: new Uint8Array(32),
          performInitialResolve: true,
          onSnapshot,
        });

        // Let the async IIFE run
        await vi.advanceTimersByTimeAsync(0);

        expect(resolveIPNS).toHaveBeenCalledWith(
          helia,
          new Uint8Array(32),
        );
        expect(onSnapshot).toHaveBeenCalledWith(
          tipCid,
        );
        expect(
          announceSnapshot,
        ).toHaveBeenCalledWith(
          pubsub,
          "test",
          "abc123",
          tipCid.toString(),
          undefined,
        );

        watcher.destroy();
      },
    );

    it(
      "skips onSnapshot when resolve returns null",
      async () => {
        vi.mocked(resolveIPNS)
          .mockResolvedValue(null);

        const onSnapshot = vi.fn();
        const pubsub = {
          subscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          publish:
            vi.fn().mockResolvedValue(undefined),
        };
        const helia = {
          blockstore: { get: vi.fn() },
        };

        const watcher = createSnapshotWatcher({
          appId: "test",
          ipnsName: "abc123",
          pubsub: pubsub as any,
          getHelia: () => helia as any,
          isWriter: false,
          ipnsPublicKeyBytes: new Uint8Array(32),
          performInitialResolve: true,
          onSnapshot,
        });

        await vi.advanceTimersByTimeAsync(0);

        expect(
          onSnapshot,
        ).not.toHaveBeenCalled();

        watcher.destroy();
      },
    );

    it(
      "skips onSnapshot if destroyed before " +
        "resolve completes",
      async () => {
        const tipCid = await fakeCid(42);
        // Resolve that never settles until we
        // advance timers
        let resolvePromise!: (
          v: CID | null,
        ) => void;
        vi.mocked(resolveIPNS).mockReturnValue(
          new Promise((r) => {
            resolvePromise = r;
          }),
        );

        const onSnapshot = vi.fn();
        const pubsub = {
          subscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          publish:
            vi.fn().mockResolvedValue(undefined),
        };
        const helia = {
          blockstore: { get: vi.fn() },
        };

        const watcher = createSnapshotWatcher({
          appId: "test",
          ipnsName: "abc123",
          pubsub: pubsub as any,
          getHelia: () => helia as any,
          isWriter: false,
          ipnsPublicKeyBytes: new Uint8Array(32),
          performInitialResolve: true,
          onSnapshot,
        });

        // Destroy before resolve completes
        watcher.destroy();

        // Now resolve
        resolvePromise(tipCid);
        await vi.advanceTimersByTimeAsync(0);

        expect(
          onSnapshot,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "schedules retry when onSnapshot fails",
      async () => {
        const tipCid = await fakeCid(42);
        vi.mocked(resolveIPNS)
          .mockResolvedValue(tipCid);

        const onSnapshot = vi.fn()
          .mockRejectedValueOnce(
            new Error("fetch failed"),
          )
          .mockResolvedValue(undefined);
        const pubsub = {
          subscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          publish:
            vi.fn().mockResolvedValue(undefined),
        };
        const helia = {
          blockstore: { get: vi.fn() },
        };

        const watcher = createSnapshotWatcher({
          appId: "test",
          ipnsName: "abc123",
          pubsub: pubsub as any,
          getHelia: () => helia as any,
          isWriter: false,
          ipnsPublicKeyBytes: new Uint8Array(32),
          performInitialResolve: true,
          onSnapshot,
        });

        // Let initial resolve run and fail
        await vi.advanceTimersByTimeAsync(0);
        expect(onSnapshot).toHaveBeenCalledTimes(1);

        // Advance past RETRY_INTERVAL_MS (30s)
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onSnapshot).toHaveBeenCalledTimes(2);

        watcher.destroy();
      },
    );

    it(
      "does not resolve without " +
        "ipnsPublicKeyBytes",
      async () => {
        const onSnapshot = vi.fn();
        const pubsub = {
          subscribe: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          publish:
            vi.fn().mockResolvedValue(undefined),
        };
        const helia = {
          blockstore: { get: vi.fn() },
        };

        const watcher = createSnapshotWatcher({
          appId: "test",
          ipnsName: "abc123",
          pubsub: pubsub as any,
          getHelia: () => helia as any,
          isWriter: false,
          performInitialResolve: true,
          onSnapshot,
        });

        await vi.advanceTimersByTimeAsync(0);

        expect(
          resolveIPNS,
        ).not.toHaveBeenCalled();

        watcher.destroy();
      },
    );
  });
});
