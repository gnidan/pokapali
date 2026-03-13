import { describe, it, expect } from "vitest";
import { createTestNetwork } from "./test-network.js";

describe("createTestNetwork", () => {
  describe("basic sync", () => {
    it("propagates edits between peers", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      alice.channel("content").getMap("data").set("key", "value");

      expect(bob.channel("content").getMap("data").get("key")).toBe("value");

      net.destroy();
    });

    it("syncs multiple channels", () => {
      const net = createTestNetwork({
        channels: ["content", "comments"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      alice.channel("content").getMap("x").set("a", 1);
      alice.channel("comments").getMap("x").set("b", 2);

      expect(bob.channel("content").getMap("x").get("a")).toBe(1);
      expect(bob.channel("comments").getMap("x").get("b")).toBe(2);

      net.destroy();
    });

    it("syncs three peers", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");
      const charlie = net.peer("charlie");

      alice.channel("content").getMap("d").set("from", "alice");

      expect(bob.channel("content").getMap("d").get("from")).toBe("alice");
      expect(charlie.channel("content").getMap("d").get("from")).toBe("alice");

      net.destroy();
    });

    it("peer() is idempotent", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const a1 = net.peer("alice");
      const a2 = net.peer("alice");

      a1.channel("content").getMap("x").set("k", "v");
      expect(a2.channel("content").getMap("x").get("k")).toBe("v");

      net.destroy();
    });

    it("late peer gets existing state", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      alice.channel("content").getMap("d").set("early", true);

      const bob = net.peer("bob");
      expect(bob.channel("content").getMap("d").get("early")).toBe(true);

      net.destroy();
    });
  });

  describe("disconnect / reconnect", () => {
    it("disconnected peers don't sync", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      net.disconnect("alice", "bob");

      alice.channel("content").getMap("d").set("offline", true);

      expect(bob.channel("content").getMap("d").get("offline")).toBeUndefined();

      net.destroy();
    });

    it("reconnect flushes pending state", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      net.disconnect("alice", "bob");

      alice.channel("content").getMap("d").set("a", 1);
      bob.channel("content").getMap("d").set("b", 2);

      net.reconnect("alice", "bob");

      expect(alice.channel("content").getMap("d").get("b")).toBe(2);
      expect(bob.channel("content").getMap("d").get("a")).toBe(1);

      net.destroy();
    });

    it("concurrent edits merge on reconnect", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      net.disconnect("alice", "bob");

      // Both edit the same map, different keys.
      alice.channel("content").getMap("d").set("alice-key", "alice-val");
      bob.channel("content").getMap("d").set("bob-key", "bob-val");

      net.reconnect("alice", "bob");

      // Both keys present on both sides.
      const aMap = alice.channel("content").getMap("d");
      const bMap = bob.channel("content").getMap("d");

      expect(aMap.get("alice-key")).toBe("alice-val");
      expect(aMap.get("bob-key")).toBe("bob-val");
      expect(bMap.get("alice-key")).toBe("alice-val");
      expect(bMap.get("bob-key")).toBe("bob-val");

      net.destroy();
    });

    it("reconnect is idempotent", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");
      net.peer("bob");

      // Already connected — reconnect is no-op.
      expect(() => net.reconnect("alice", "bob")).not.toThrow();

      net.destroy();
    });
  });

  describe("partition / heal", () => {
    it("partition isolates groups", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");
      const charlie = net.peer("charlie");

      net.partition(["alice"], ["bob", "charlie"]);

      alice.channel("content").getMap("d").set("isolated", true);

      // Bob and Charlie don't see it.
      expect(
        bob.channel("content").getMap("d").get("isolated"),
      ).toBeUndefined();
      expect(
        charlie.channel("content").getMap("d").get("isolated"),
      ).toBeUndefined();

      // Bob and Charlie still sync with each other.
      bob.channel("content").getMap("d").set("intra", true);
      expect(charlie.channel("content").getMap("d").get("intra")).toBe(true);

      net.destroy();
    });

    it("heal reconnects all peers", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");
      const charlie = net.peer("charlie");

      net.partition(["alice"], ["bob", "charlie"]);

      alice.channel("content").getMap("d").set("a", 1);
      bob.channel("content").getMap("d").set("b", 2);

      net.heal();

      expect(alice.channel("content").getMap("d").get("b")).toBe(2);
      expect(bob.channel("content").getMap("d").get("a")).toBe(1);
      expect(charlie.channel("content").getMap("d").get("a")).toBe(1);

      net.destroy();
    });

    it("three-way partition and heal", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");
      const charlie = net.peer("charlie");

      net.partition(["alice"], ["bob"], ["charlie"]);

      alice.channel("content").getMap("d").set("a", 1);
      bob.channel("content").getMap("d").set("b", 2);
      charlie.channel("content").getMap("d").set("c", 3);

      net.heal();

      for (const p of [alice, bob, charlie]) {
        const m = p.channel("content").getMap("d");
        expect(m.get("a")).toBe(1);
        expect(m.get("b")).toBe(2);
        expect(m.get("c")).toBe(3);
      }

      net.destroy();
    });
  });

  describe("isConverged", () => {
    it("returns true for synced peers", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");
      net.peer("bob");

      net.peer("alice").channel("content").getMap("d").set("k", "v");

      expect(net.isConverged()).toBe(true);
      net.destroy();
    });

    it("returns false for diverged peers", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");
      net.peer("bob");

      net.disconnect("alice", "bob");

      net.peer("alice").channel("content").getMap("d").set("diverged", true);

      expect(net.isConverged()).toBe(false);
      net.destroy();
    });

    it("returns true after heal", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");
      net.peer("bob");

      net.disconnect("alice", "bob");
      net.peer("alice").channel("content").getMap("d").set("x", 1);

      expect(net.isConverged()).toBe(false);

      net.heal();
      expect(net.isConverged()).toBe(true);

      net.destroy();
    });

    it("returns true for single peer", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");
      expect(net.isConverged()).toBe(true);
      net.destroy();
    });

    it("checks all channels", () => {
      const net = createTestNetwork({
        channels: ["content", "comments"],
      });
      net.peer("alice");
      net.peer("bob");

      net.disconnect("alice", "bob");

      // Diverge only on comments channel.
      net.peer("alice").channel("comments").getMap("d").set("x", 1);

      expect(net.isConverged()).toBe(false);
      net.destroy();
    });
  });

  describe("latency simulation", () => {
    it("updates are delayed when latency " + "is configured", async () => {
      const net = createTestNetwork({
        channels: ["content"],
        latency: { ms: 50 },
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      alice.channel("content").getMap("d").set("key", "value");

      // Not yet delivered
      expect(bob.channel("content").getMap("d").get("key")).toBeUndefined();
      expect(net.isConverged()).toBe(false);

      // Wait for delivery
      await net.settle();
      expect(bob.channel("content").getMap("d").get("key")).toBe("value");
      expect(net.isConverged()).toBe(true);

      net.destroy();
    });

    it("no latency option keeps sync behavior", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      alice.channel("content").getMap("d").set("key", "value");

      // Immediate — no settle() needed
      expect(bob.channel("content").getMap("d").get("key")).toBe("value");

      net.destroy();
    });

    it("settle resolves immediately when " + "no pending updates", async () => {
      const net = createTestNetwork({
        channels: ["content"],
        latency: { ms: 10 },
      });
      net.peer("alice");

      await net.settle();
      // Should not hang

      net.destroy();
    });

    it("concurrent edits from both peers " + "merge after settle", async () => {
      const net = createTestNetwork({
        channels: ["content"],
        latency: { ms: 20 },
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      net.disconnect("alice", "bob");

      alice.channel("content").getMap("d").set("a", 1);
      bob.channel("content").getMap("d").set("b", 2);

      net.reconnect("alice", "bob");
      await net.settle();

      expect(alice.channel("content").getMap("d").get("b")).toBe(2);
      expect(bob.channel("content").getMap("d").get("a")).toBe(1);

      net.destroy();
    });

    it("jitter varies delivery times", async () => {
      const net = createTestNetwork({
        channels: ["content"],
        latency: { ms: 10, jitter: 5 },
      });
      const alice = net.peer("alice");
      const bob = net.peer("bob");

      alice.channel("content").getMap("d").set("key", "value");

      // Eventually arrives
      await net.settle();
      expect(bob.channel("content").getMap("d").get("key")).toBe("value");

      net.destroy();
    });

    it("destroy cancels pending deliveries", async () => {
      const net = createTestNetwork({
        channels: ["content"],
        latency: { ms: 1000 },
      });
      const alice = net.peer("alice");
      net.peer("bob");

      alice.channel("content").getMap("d").set("key", "value");

      // Destroy while update is in flight
      net.destroy();

      // settle on destroyed network resolves
      // immediately (no pending work)
      await net.settle();
    });

    it(
      "late peer gets existing state " + "immediately even with latency",
      async () => {
        const net = createTestNetwork({
          channels: ["content"],
          latency: { ms: 50 },
        });
        const alice = net.peer("alice");
        alice.channel("content").getMap("d").set("early", true);

        await net.settle();

        // New peer joins — initial sync is
        // immediate (not delayed)
        const bob = net.peer("bob");
        expect(bob.channel("content").getMap("d").get("early")).toBe(true);

        net.destroy();
      },
    );
  });

  describe("realistic network scenarios", () => {
    it(
      "three peers converge under " + "moderate latency with jitter",
      async () => {
        const net = createTestNetwork({
          channels: ["content", "comments"],
          latency: { ms: 100, jitter: 50 },
        });
        const alice = net.peer("alice");
        const bob = net.peer("bob");
        const charlie = net.peer("charlie");

        // All three edit different channels
        // concurrently.
        alice.channel("content").getMap("d").set("title", "Hello");
        bob.channel("comments").getMap("d").set("c1", "Nice doc");
        charlie.channel("content").getMap("d").set("footer", "Bye");

        // Not converged yet — updates in flight.
        expect(net.isConverged()).toBe(false);

        await net.settle();

        // All peers see all edits.
        expect(net.isConverged()).toBe(true);
        for (const p of [alice, bob, charlie]) {
          expect(p.channel("content").getMap("d").get("title")).toBe("Hello");
          expect(p.channel("content").getMap("d").get("footer")).toBe("Bye");
          expect(p.channel("comments").getMap("d").get("c1")).toBe("Nice doc");
        }

        net.destroy();
      },
    );

    it(
      "partition + heal under high latency " + "preserves all edits",
      async () => {
        const net = createTestNetwork({
          channels: ["content"],
          latency: { ms: 200, jitter: 50 },
        });
        const alice = net.peer("alice");
        const bob = net.peer("bob");
        const charlie = net.peer("charlie");

        // Let initial sync settle.
        await net.settle();

        // Partition: alice alone, bob+charlie together.
        net.partition(["alice"], ["bob", "charlie"]);

        // Each side edits independently.
        alice.channel("content").getMap("d").set("a", "from-alice");
        bob.channel("content").getMap("d").set("b", "from-bob");
        charlie.channel("content").getMap("d").set("c", "from-charlie");

        await net.settle();

        // Bob and Charlie converged with each other.
        expect(bob.channel("content").getMap("d").get("c")).toBe(
          "from-charlie",
        );
        expect(charlie.channel("content").getMap("d").get("b")).toBe(
          "from-bob",
        );

        // Alice is still isolated.
        expect(alice.channel("content").getMap("d").get("b")).toBeUndefined();

        // Heal the network.
        net.heal();
        await net.settle();

        // Full convergence.
        expect(net.isConverged()).toBe(true);
        for (const p of [alice, bob, charlie]) {
          const m = p.channel("content").getMap("d");
          expect(m.get("a")).toBe("from-alice");
          expect(m.get("b")).toBe("from-bob");
          expect(m.get("c")).toBe("from-charlie");
        }

        net.destroy();
      },
    );

    it(
      "rapid edits from many peers converge " + "under jittery latency",
      async () => {
        const net = createTestNetwork({
          channels: ["content"],
          latency: { ms: 50, jitter: 30 },
        });

        const peers = Array.from({ length: 5 }, (_, i) =>
          net.peer(`peer-${i}`),
        );

        // Each peer writes 10 keys rapidly.
        for (const p of peers) {
          const map = p.channel("content").getMap("d");
          for (let k = 0; k < 10; k++) {
            map.set(`${p.name}-${k}`, k);
          }
        }

        await net.settle();

        expect(net.isConverged()).toBe(true);

        // Verify all 50 keys visible to every peer.
        for (const p of peers) {
          const map = p.channel("content").getMap("d");
          for (const other of peers) {
            for (let k = 0; k < 10; k++) {
              expect(map.get(`${other.name}-${k}`)).toBe(k);
            }
          }
        }

        net.destroy();
      },
    );

    it(
      "disconnect during latency window " + "drops in-flight updates",
      async () => {
        const net = createTestNetwork({
          channels: ["content"],
          latency: { ms: 200 },
        });
        const alice = net.peer("alice");
        const bob = net.peer("bob");

        // Alice sends — update is in-flight (200ms).
        alice.channel("content").getMap("d").set("key", "val");

        // Disconnect before delivery.
        net.disconnect("alice", "bob");

        await net.settle();

        // Bob never got it — link was severed
        // before delivery.
        expect(bob.channel("content").getMap("d").get("key")).toBeUndefined();

        // Reconnect flushes state.
        net.reconnect("alice", "bob");

        expect(bob.channel("content").getMap("d").get("key")).toBe("val");

        net.destroy();
      },
    );

    it(
      "multiple channels converge " + "independently under latency",
      async () => {
        const net = createTestNetwork({
          channels: ["content", "comments", "meta"],
          latency: { ms: 75, jitter: 25 },
        });
        const alice = net.peer("alice");
        const bob = net.peer("bob");

        alice.channel("content").getMap("d").set("title", "Doc");
        alice.channel("comments").getArray("list").push(["first comment"]);
        alice.channel("meta").getMap("d").set("author", "alice");

        bob.channel("content").getMap("d").set("body", "Hello world");
        bob.channel("comments").getArray("list").push(["reply"]);
        bob.channel("meta").getMap("d").set("editor", "bob");

        await net.settle();

        expect(net.isConverged()).toBe(true);

        // Content channel.
        expect(alice.channel("content").getMap("d").get("body")).toBe(
          "Hello world",
        );
        expect(bob.channel("content").getMap("d").get("title")).toBe("Doc");

        // Comments channel — both entries present.
        expect(alice.channel("comments").getArray("list").length).toBe(2);
        expect(bob.channel("comments").getArray("list").length).toBe(2);

        // Meta channel.
        expect(alice.channel("meta").getMap("d").get("editor")).toBe("bob");
        expect(bob.channel("meta").getMap("d").get("author")).toBe("alice");

        net.destroy();
      },
    );
  });

  describe("errors", () => {
    it("throws on unknown channel", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      const alice = net.peer("alice");

      expect(() => alice.channel("nonexistent")).toThrow(/Unknown channel/);

      net.destroy();
    });

    it("throws on unknown peer for disconnect", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.peer("alice");

      expect(() => net.disconnect("alice", "ghost")).toThrow(/Unknown peer/);

      net.destroy();
    });

    it("throws after destroy", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.destroy();

      expect(() => net.peer("alice")).toThrow(/destroyed/);
    });

    it("double destroy is safe", () => {
      const net = createTestNetwork({
        channels: ["content"],
      });
      net.destroy();
      expect(() => net.destroy()).not.toThrow();
    });
  });
});
