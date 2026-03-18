/**
 * Integration tests for the announce protocol with
 * real snapshot data.
 *
 * Exercises the cross-package message flow:
 * @pokapali/crypto (keys) →
 * @pokapali/snapshot (encode) →
 * @pokapali/core/announce (publish/parse) →
 * @pokapali/snapshot (decode + verify).
 *
 * Tests the encode → publish → parse → decode round
 * trip that existing unit tests skip (they use fake
 * strings for ipnsName/cid/block).
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
} from "@pokapali/crypto";
import {
  encodeSnapshot,
  decodeSnapshot,
  validateSnapshot,
} from "@pokapali/snapshot";
import {
  announceSnapshot,
  announceAck,
  parseAnnouncement,
  parseGuaranteeResponse,
  publishGuaranteeQuery,
  base64ToUint8,
} from "./announce.js";
import type { AnnouncePubSub } from "./announce.js";

// --- Helpers ---

const DAG_CBOR_CODE = 0x71;
const APP_ID = "test-app";

/** Capture pubsub.publish calls. */
function capturePubSub(): {
  pubsub: AnnouncePubSub;
  messages: Array<{ topic: string; data: Uint8Array }>;
} {
  const messages: Array<{
    topic: string;
    data: Uint8Array;
  }> = [];
  return {
    pubsub: {
      publish: vi.fn(async (topic: string, data: Uint8Array) => {
        messages.push({ topic, data });
      }),
    },
    messages,
  };
}

async function makeSnapshot(
  text: string,
  prev: CID | null,
  seq: number,
): Promise<{
  cid: CID;
  block: Uint8Array;
  readKey: CryptoKey;
  ipnsName: string;
}> {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, APP_ID, ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

  const ydoc = new Y.Doc();
  ydoc.getText("content").insert(0, text);
  const state = Y.encodeStateAsUpdate(ydoc);

  const block = await encodeSnapshot(
    { content: state },
    keys.readKey,
    prev,
    seq,
    Date.now(),
    signingKey,
  );
  const hash = await sha256.digest(block);
  const cid = CID.createV1(DAG_CBOR_CODE, hash);

  // Derive IPNS name from public key (hex-encoded)
  const ipnsName = Array.from(signingKey.publicKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    cid,
    block,
    readKey: keys.readKey,
    ipnsName,
  };
}

// --- Tests ---

describe("announce protocol integration", () => {
  it(
    "announce with real inline block " + "round-trips through parse",
    async () => {
      const { cid, block, ipnsName } = await makeSnapshot("hello", null, 1);

      const { pubsub, messages } = capturePubSub();

      await announceSnapshot(
        pubsub,
        APP_ID,
        ipnsName,
        cid.toString(),
        1,
        block,
      );

      expect(messages).toHaveLength(1);

      // Parse the raw message as a receiver would
      const parsed = parseAnnouncement(messages[0]!.data);
      expect(parsed).not.toBeNull();
      expect(parsed!.ipnsName).toBe(ipnsName);
      expect(parsed!.cid).toBe(cid.toString());
      expect(parsed!.seq).toBe(1);

      // Decode the inline block back to a real
      // snapshot
      expect(parsed!.block).toBeDefined();
      const recoveredBlock = base64ToUint8(parsed!.block!);
      const decoded = decodeSnapshot(recoveredBlock);
      expect(decoded.seq).toBe(1);
      expect(decoded.prev).toBeNull();

      // Validate signature on the recovered block
      const valid = await validateSnapshot(recoveredBlock);
      expect(valid).toBe(true);
    },
  );

  it("announce → ack → guarantee-response " + "full message flow", async () => {
    const { cid, block, ipnsName } = await makeSnapshot("ack-test", null, 1);
    const { pubsub, messages } = capturePubSub();

    // Step 1: Writer announces snapshot
    await announceSnapshot(pubsub, APP_ID, ipnsName, cid.toString(), 1, block);

    // Step 2: Pinner sends ack with guarantee
    await announceAck(
      pubsub,
      APP_ID,
      ipnsName,
      cid.toString(),
      "pinner-1",
      Date.now() + 7 * 24 * 3600_000,
      Date.now() + 14 * 24 * 3600_000,
    );

    expect(messages).toHaveLength(2);

    // Parse the ack message
    const ackMsg = parseAnnouncement(messages[1]!.data);
    expect(ackMsg).not.toBeNull();
    expect(ackMsg!.ack).toBeDefined();
    expect(ackMsg!.ack!.peerId).toBe("pinner-1");
    expect(ackMsg!.ack!.guaranteeUntil).toBeGreaterThan(Date.now());
    expect(ackMsg!.ack!.retainUntil).toBeGreaterThan(
      ackMsg!.ack!.guaranteeUntil!,
    );
  });

  it("guarantee query → response round trip", async () => {
    const { cid, ipnsName } = await makeSnapshot("guarantee", null, 1);
    const { pubsub, messages } = capturePubSub();

    // Browser sends guarantee query
    await publishGuaranteeQuery(pubsub, APP_ID, ipnsName);

    expect(messages).toHaveLength(1);

    // Simulate pinner response (manually
    // constructed as the pinner would)
    const response = new TextEncoder().encode(
      JSON.stringify({
        type: "guarantee-response",
        ipnsName,
        peerId: "pinner-2",
        cid: cid.toString(),
        guaranteeUntil: Date.now() + 7 * 24 * 3600_000,
        retainUntil: Date.now() + 14 * 24 * 3600_000,
      }),
    );

    const parsed = parseGuaranteeResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.ipnsName).toBe(ipnsName);
    expect(parsed!.peerId).toBe("pinner-2");
    expect(parsed!.cid).toBe(cid.toString());
    expect(parsed!.guaranteeUntil).toBeGreaterThan(Date.now());
  });

  it("inline block omitted for oversized " + "snapshots", async () => {
    // Create a snapshot larger than 1MB
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, APP_ID, ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);

    const ydoc = new Y.Doc();
    // Insert enough text to exceed 1MB when
    // encrypted. Each char ≈ 1 byte in Yjs state.
    const bigText = "x".repeat(1024 * 1024);
    ydoc.getText("content").insert(0, bigText);
    const state = Y.encodeStateAsUpdate(ydoc);

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

    const { pubsub, messages } = capturePubSub();

    await announceSnapshot(pubsub, APP_ID, "big-doc", cid.toString(), 1, block);

    const parsed = parseAnnouncement(messages[0]!.data);
    expect(parsed).not.toBeNull();
    // Block should be omitted (>1MB)
    expect(parsed!.block).toBeUndefined();
    // CID and seq still present
    expect(parsed!.cid).toBe(cid.toString());
    expect(parsed!.seq).toBe(1);
  });
});
