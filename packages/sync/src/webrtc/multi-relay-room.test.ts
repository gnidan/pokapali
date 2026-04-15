import { describe, it, expect, vi } from "vitest";
import { createMultiRelayRoom } from "./multi-relay-room.js";
import type { AwarenessRoom } from "./rooms.js";

function mockAwareness() {
  return {} as AwarenessRoom["awareness"];
}

interface MockRoom extends AwarenessRoom {
  _statusCbs: Set<() => void>;
  _createdCbs: Set<(pc: RTCPeerConnection, init: boolean) => void>;
  _connCbs: Set<(pc: RTCPeerConnection, init: boolean) => void>;
  _swapCbs: Set<() => void>;
  _connected: boolean;
}

function mockRoom(): MockRoom {
  const _statusCbs = new Set<() => void>();
  const _createdCbs = new Set<(pc: RTCPeerConnection, init: boolean) => void>();
  const _connCbs = new Set<(pc: RTCPeerConnection, init: boolean) => void>();
  const _swapCbs = new Set<() => void>();

  const room: MockRoom = {
    awareness: mockAwareness(),
    _connected: false,
    get connected() {
      return this._connected;
    },
    onStatusChange(cb: () => void) {
      _statusCbs.add(cb);
    },
    onPeerCreated(cb: (pc: RTCPeerConnection, init: boolean) => void) {
      _createdCbs.add(cb);
      return () => _createdCbs.delete(cb);
    },
    onPeerConnection(cb: (pc: RTCPeerConnection, init: boolean) => void) {
      _connCbs.add(cb);
      return () => _connCbs.delete(cb);
    },
    onNeedsSwap(cb: () => void) {
      _swapCbs.add(cb);
      return () => _swapCbs.delete(cb);
    },
    destroy: vi.fn(),
    _statusCbs,
    _createdCbs,
    _connCbs,
    _swapCbs,
  };
  return room;
}

describe("MultiRelayRoom", () => {
  it("starts disconnected with no relays", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    expect(multi.connected).toBe(false);
    multi.destroy();
  });

  it("connected aggregates across relays", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();
    const r2 = mockRoom();

    multi.addRelay("relay-a", r1);
    multi.addRelay("relay-b", r2);
    expect(multi.connected).toBe(false);

    r1._connected = true;
    expect(multi.connected).toBe(true);

    r1._connected = false;
    expect(multi.connected).toBe(false);

    r2._connected = true;
    expect(multi.connected).toBe(true);

    multi.destroy();
  });

  it("fires statusChange on sub-room changes", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();

    const cb = vi.fn();
    multi.onStatusChange(cb);
    multi.addRelay("relay-a", r1);

    // addRelay fires statusChange
    expect(cb).toHaveBeenCalledTimes(1);

    // Sub-room status change propagates
    for (const fn of r1._statusCbs) fn();
    expect(cb).toHaveBeenCalledTimes(2);

    multi.destroy();
  });

  it("forwards onPeerCreated from sub-rooms", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();

    const cb = vi.fn();
    multi.onPeerCreated(cb);
    multi.addRelay("relay-a", r1);

    const fakePC = {} as RTCPeerConnection;
    for (const fn of r1._createdCbs) fn(fakePC, true);

    expect(cb).toHaveBeenCalledWith(fakePC, true);

    multi.destroy();
  });

  it("forwards onPeerConnection from sub-rooms", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();

    const cb = vi.fn();
    multi.onPeerConnection(cb);
    multi.addRelay("relay-a", r1);

    const fakePC = {} as RTCPeerConnection;
    for (const fn of r1._connCbs) fn(fakePC, false);

    expect(cb).toHaveBeenCalledWith(fakePC, false);

    multi.destroy();
  });

  it("removeRelay destroys sub-room and cleans up", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();

    multi.addRelay("relay-a", r1);
    expect(multi.connected).toBe(false);

    multi.removeRelay("relay-a");
    expect(r1.destroy).toHaveBeenCalled();

    // Status change should fire on remove
    const cb = vi.fn();
    multi.onStatusChange(cb);

    // Adding again should work
    const r2 = mockRoom();
    multi.addRelay("relay-a", r2);

    multi.destroy();
  });

  it("duplicate addRelay destroys the new room", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();
    const r2 = mockRoom();

    multi.addRelay("relay-a", r1);
    multi.addRelay("relay-a", r2);

    expect(r2.destroy).toHaveBeenCalled();
    expect(r1.destroy).not.toHaveBeenCalled();

    multi.destroy();
  });

  it("destroy cleans up all sub-rooms", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();
    const r2 = mockRoom();

    multi.addRelay("relay-a", r1);
    multi.addRelay("relay-b", r2);

    multi.destroy();

    expect(r1.destroy).toHaveBeenCalled();
    expect(r2.destroy).toHaveBeenCalled();
  });

  it("addRelay after destroy destroys the room", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    multi.destroy();

    const r1 = mockRoom();
    multi.addRelay("relay-a", r1);
    expect(r1.destroy).toHaveBeenCalled();
  });

  it("fires needsSwap when all relays removed", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();
    const r2 = mockRoom();

    multi.addRelay("relay-a", r1);
    multi.addRelay("relay-b", r2);

    const cb = vi.fn();
    multi.onNeedsSwap(cb);

    multi.removeRelay("relay-a");
    expect(cb).not.toHaveBeenCalled();

    multi.removeRelay("relay-b");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("sub-room needsSwap removes that relay", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();
    const r2 = mockRoom();

    multi.addRelay("relay-a", r1);
    multi.addRelay("relay-b", r2);

    const cb = vi.fn();
    multi.onNeedsSwap(cb);

    // Simulate r1's signaling dying + peers dropping
    for (const fn of r1._swapCbs) fn();

    expect(r1.destroy).toHaveBeenCalled();
    // r2 still alive, no needsSwap on multi
    expect(cb).not.toHaveBeenCalled();

    // Now r2 dies too
    for (const fn of r2._swapCbs) fn();
    expect(r2.destroy).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe works for all callbacks", () => {
    const multi = createMultiRelayRoom(mockAwareness());
    const r1 = mockRoom();

    const createdCb = vi.fn();
    const connCb = vi.fn();
    const swapCb = vi.fn();

    const unsubCreated = multi.onPeerCreated(createdCb);
    const unsubConn = multi.onPeerConnection(connCb);
    const unsubSwap = multi.onNeedsSwap(swapCb);

    multi.addRelay("relay-a", r1);

    unsubCreated();
    unsubConn();
    unsubSwap();

    const fakePC = {} as RTCPeerConnection;
    for (const fn of r1._createdCbs) fn(fakePC, true);
    for (const fn of r1._connCbs) fn(fakePC, false);

    expect(createdCb).not.toHaveBeenCalled();
    expect(connCb).not.toHaveBeenCalled();

    multi.removeRelay("relay-a");
    expect(swapCb).not.toHaveBeenCalled();

    multi.destroy();
  });
});
