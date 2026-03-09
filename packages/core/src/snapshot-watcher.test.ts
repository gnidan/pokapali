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
import { watchIPNS } from "./ipns-helpers.js";
import {
  announceTopic,
  parseAnnouncement,
} from "./announce.js";

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
});
