import { describe, it, expect, vi } from "vitest";
import { createRoomRegistry } from "./registry.js";

describe("RoomRegistry", () => {
  it("join adds peer to room", () => {
    const reg = createRoomRegistry();
    const send = vi.fn();
    reg.join("room-a", { peerId: "p1", send });

    expect(reg.members("room-a")).toHaveLength(1);
    expect(reg.members("room-a")[0]!.peerId).toBe("p1");
  });

  it("members returns empty for unknown room", () => {
    const reg = createRoomRegistry();
    expect(reg.members("nope")).toEqual([]);
  });

  it("leave removes peer from room", () => {
    const reg = createRoomRegistry();
    reg.join("room-a", {
      peerId: "p1",
      send: vi.fn(),
    });
    reg.join("room-a", {
      peerId: "p2",
      send: vi.fn(),
    });

    reg.leave("room-a", "p1");
    const ids = reg.members("room-a").map((m) => m.peerId);
    expect(ids).toEqual(["p2"]);
  });

  it("leave cleans up empty rooms", () => {
    const reg = createRoomRegistry();
    reg.join("room-a", {
      peerId: "p1",
      send: vi.fn(),
    });
    reg.leave("room-a", "p1");
    expect(reg.members("room-a")).toEqual([]);
  });

  it("leave on unknown room is a no-op", () => {
    const reg = createRoomRegistry();
    expect(() => reg.leave("nope", "p1")).not.toThrow();
  });

  it("leaveAll removes peer from all rooms " + "and returns room names", () => {
    const reg = createRoomRegistry();
    const send = vi.fn();
    reg.join("room-a", { peerId: "p1", send });
    reg.join("room-b", { peerId: "p1", send });
    reg.join("room-a", {
      peerId: "p2",
      send: vi.fn(),
    });

    const left = reg.leaveAll("p1");
    expect(left.sort()).toEqual(["room-a", "room-b"].sort());
    expect(reg.members("room-a")).toHaveLength(1);
    expect(reg.members("room-b")).toEqual([]);
  });

  it("leaveAll returns empty for unknown peer", () => {
    const reg = createRoomRegistry();
    expect(reg.leaveAll("nobody")).toEqual([]);
  });

  it("findPeer returns entry if present", () => {
    const reg = createRoomRegistry();
    const send = vi.fn();
    reg.join("room-a", { peerId: "p1", send });

    const found = reg.findPeer("room-a", "p1");
    expect(found).toBeDefined();
    expect(found!.peerId).toBe("p1");
    expect(found!.send).toBe(send);
  });

  it("findPeer returns undefined if not present", () => {
    const reg = createRoomRegistry();
    expect(reg.findPeer("room-a", "p1")).toBeUndefined();
  });

  it("multiple peers in same room are isolated", () => {
    const reg = createRoomRegistry();
    const s1 = vi.fn();
    const s2 = vi.fn();
    reg.join("room-a", { peerId: "p1", send: s1 });
    reg.join("room-a", { peerId: "p2", send: s2 });

    expect(reg.members("room-a")).toHaveLength(2);
    expect(reg.findPeer("room-a", "p1")!.send).toBe(s1);
    expect(reg.findPeer("room-a", "p2")!.send).toBe(s2);
  });

  it("rooms are isolated from each other", () => {
    const reg = createRoomRegistry();
    reg.join("room-a", {
      peerId: "p1",
      send: vi.fn(),
    });
    reg.join("room-b", {
      peerId: "p2",
      send: vi.fn(),
    });

    expect(reg.findPeer("room-a", "p2")).toBeUndefined();
    expect(reg.findPeer("room-b", "p1")).toBeUndefined();
  });

  it("leaveAll with matching send removes entry", () => {
    const reg = createRoomRegistry();
    const send = vi.fn();
    reg.join("room-a", { peerId: "p1", send });
    const left = reg.leaveAll("p1", send);
    expect(left).toEqual(["room-a"]);
    expect(reg.members("room-a")).toHaveLength(0);
  });

  it(
    "leaveAll with non-matching send preserves " + "entry (reconnect race)",
    () => {
      const reg = createRoomRegistry();
      const oldSend = vi.fn();
      const newSend = vi.fn();

      // New stream already re-registered this peer
      reg.join("room-a", {
        peerId: "p1",
        send: newSend,
      });

      // Old stream cleanup fires — must not remove
      // the new stream's entry
      const left = reg.leaveAll("p1", oldSend);
      expect(left).toEqual([]);
      expect(reg.members("room-a")).toHaveLength(1);
      expect(reg.findPeer("room-a", "p1")?.send).toBe(newSend);
    },
  );

  it(
    "reconnect race: old leaveAll after new join " + "across multiple rooms",
    () => {
      const reg = createRoomRegistry();
      const oldSend = vi.fn();
      const newSend = vi.fn();

      // Old stream had peer in two rooms
      reg.join("room-a", {
        peerId: "p1",
        send: oldSend,
      });
      reg.join("room-b", {
        peerId: "p1",
        send: oldSend,
      });

      // New stream re-registers in room-a only
      reg.join("room-a", {
        peerId: "p1",
        send: newSend,
      });

      // Old cleanup: should skip room-a (send
      // mismatch) but remove room-b (send matches)
      const left = reg.leaveAll("p1", oldSend);
      expect(left).toEqual(["room-b"]);
      expect(reg.findPeer("room-a", "p1")?.send).toBe(newSend);
      expect(reg.findPeer("room-b", "p1")).toBeUndefined();
    },
  );
});
