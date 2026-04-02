import { describe, test, expect, vi } from "vitest";
import * as Y from "yjs";
import { encodeSnapshot } from "@pokapali/blocks";
import {
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  generateAdminSecret,
  bytesToHex,
} from "@pokapali/crypto";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";

import { startReaderPeer, type ReaderPeerEvent } from "./reader-peer.js";

const DAG_CBOR_CODE = 0x71;
const APP_ID = "test-app";

async function makeWriterFixture(content: string) {
  const adminSecret = generateAdminSecret();
  const keys = await deriveDocKeys(adminSecret, APP_ID, ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  const ipnsName = bytesToHex(signingKey.publicKey);

  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);

  const state = Y.encodeStateAsUpdate(doc);
  const block = await encodeSnapshot(
    { content: state },
    keys.readKey,
    null,
    1,
    Date.now(),
    signingKey,
  );

  const hash = await sha256.digest(block);
  const cid = CID.createV1(DAG_CBOR_CODE, hash);

  return {
    ipnsName,
    readKey: keys.readKey,
    block,
    cid: cid.toString(),
    clockSum: content.length,
    doc,
  };
}

function makeAnnouncementPayload(opts: {
  ipnsName: string;
  cid: string;
  seq?: number;
  block?: Uint8Array;
  ack?: { peerId: string };
}): Uint8Array {
  let blockB64: string | undefined;
  if (opts.block) {
    let binary = "";
    for (let i = 0; i < opts.block.length; i++) {
      binary += String.fromCharCode(opts.block[i]!);
    }
    blockB64 = btoa(binary);
  }

  const msg: Record<string, unknown> = {
    ipnsName: opts.ipnsName,
    cid: opts.cid,
  };
  if (opts.seq !== undefined) msg.seq = opts.seq;
  if (blockB64) msg.block = blockB64;
  if (opts.ack) msg.ack = opts.ack;

  return new TextEncoder().encode(JSON.stringify(msg));
}

function makePubsub() {
  let handler: ((evt: unknown) => void) | null = null;
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addEventListener: vi.fn((_: string, h: (evt: unknown) => void) => {
      handler = h;
    }),
    removeEventListener: vi.fn(),
    dispatch(topic: string, data: Uint8Array) {
      handler!({ detail: { topic, data } });
    },
  };
}

const TOPIC = `/pokapali/main/app/${APP_ID}/announce`;

describe("startReaderPeer", () => {
  test("decodes and applies snapshot from announcement", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        seq: fixture.clockSum,
        block: fixture.block,
      }),
    );

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    expect(peer.syncedDocs.has(fixture.ipnsName)).toBe(true);

    const synced = events.find((e) => e.type === "reader-synced");
    expect(synced).toBeDefined();
    expect(synced!.ipnsName).toBe(fixture.ipnsName);
    expect(synced!.cid).toBe(fixture.cid);

    const conv = events.find((e) => e.type === "convergence-ok");
    expect(conv).toBeDefined();
    expect(conv!.expectedClockSum).toBe(5);
    expect(conv!.actualClockSum).toBe(5);

    peer.stop();
  });

  test("ignores ack announcements", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        ack: { peerId: "pinner-1" },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);

    peer.stop();
  });

  test("ignores announcements for unknown writers", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        seq: fixture.clockSum,
        block: fixture.block,
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);
    expect(peer.syncedDocs.size).toBe(0);

    peer.stop();
  });

  test("reports convergence-drift on clockSum mismatch", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        seq: 999,
        block: fixture.block,
      }),
    );

    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    const drift = events.find((e) => e.type === "convergence-drift");
    expect(drift).toBeDefined();
    expect(drift!.expectedClockSum).toBe(999);
    expect(drift!.actualClockSum).toBe(5);

    peer.stop();
  });

  test("ignores announcements without inline block", async () => {
    const fixture = await makeWriterFixture("test");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        seq: fixture.clockSum,
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(0);

    peer.stop();
  });

  test("tracks convergenceErrors count", async () => {
    const fixture = await makeWriterFixture("hello");
    const events: ReaderPeerEvent[] = [];

    const writers = new Map<string, CryptoKey>();
    writers.set(fixture.ipnsName, fixture.readKey);

    const pubsub = makePubsub();
    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
      onEvent: (e) => events.push(e),
    });

    expect(peer.convergenceErrors).toBe(0);

    pubsub.dispatch(
      TOPIC,
      makeAnnouncementPayload({
        ipnsName: fixture.ipnsName,
        cid: fixture.cid,
        seq: 999,
        block: fixture.block,
      }),
    );

    await vi.waitFor(() => {
      expect(peer.convergenceErrors).toBe(1);
    });

    peer.stop();
  });

  test("stop unsubscribes from pubsub", () => {
    const writers = new Map<string, CryptoKey>();
    const pubsub = makePubsub();

    const peer = startReaderPeer(pubsub, {
      appId: APP_ID,
      writers,
    });

    peer.stop();

    expect(pubsub.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
    expect(pubsub.unsubscribe).toHaveBeenCalledWith(TOPIC);
  });
});
