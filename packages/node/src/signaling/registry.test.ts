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
});
