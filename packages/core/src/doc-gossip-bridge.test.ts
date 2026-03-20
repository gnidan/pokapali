import { describe, it, expect, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { createGossipHandler } from "./doc-gossip-bridge.js";
import type { AsyncQueue } from "./sources.js";
import type { Fact } from "./facts.js";

const TOPIC = "/pokapali/app/test-app/announce";
const IPNS_NAME = "abc123";

async function makeCid(data: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(data);
  return CID.createV1(0x55, hash);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function makeEvent(
  topic: string,
  payload: Record<string, unknown>,
): CustomEvent {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  return new CustomEvent("message", {
    detail: { topic, data },
  });
}

function createQueue(): AsyncQueue<Fact> & {
  items: Fact[];
} {
  const items: Fact[] = [];
  return {
    items,
    push(fact: Fact) {
      items.push(fact);
    },
  } as AsyncQueue<Fact> & { items: Fact[] };
}

describe("createGossipHandler", () => {
  it("stores verified inline block " + "via putBlock", async () => {
    const block = new Uint8Array([1, 2, 3]);
    const cid = await makeCid(block);
    const putBlock = vi.fn();
    const fq = createQueue();

    const handler = createGossipHandler({
      topic: TOPIC,
      ipnsName: IPNS_NAME,
      factQueue: fq,
      putBlock,
    });

    handler(
      makeEvent(TOPIC, {
        ipnsName: IPNS_NAME,
        cid: cid.toString(),
        block: uint8ToBase64(block),
        seq: 1,
      }),
    );

    // Wait for async verifyCid to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(putBlock).toHaveBeenCalledWith(cid, block);
    const discovered = fq.items.find((f) => f.type === "cid-discovered");
    expect(discovered).toBeDefined();
    expect((discovered as any).block).toEqual(block);
  });

  it("rejects inline block with " + "CID hash mismatch", async () => {
    const block = new Uint8Array([1, 2, 3]);
    const cid = await makeCid(block);
    const tampered = new Uint8Array([9, 9, 9]);
    const putBlock = vi.fn();
    const fq = createQueue();

    const handler = createGossipHandler({
      topic: TOPIC,
      ipnsName: IPNS_NAME,
      factQueue: fq,
      putBlock,
    });

    handler(
      makeEvent(TOPIC, {
        ipnsName: IPNS_NAME,
        cid: cid.toString(),
        block: uint8ToBase64(tampered),
        seq: 1,
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    // putBlock should NOT be called
    expect(putBlock).not.toHaveBeenCalled();

    // cid-discovered should still be emitted
    // (without block) so the CID is tracked
    const discovered = fq.items.find((f) => f.type === "cid-discovered");
    expect(discovered).toBeDefined();
    expect((discovered as any).block).toBeUndefined();
  });

  it("emits facts without block when " + "no inline block", async () => {
    const block = new Uint8Array([10, 20]);
    const cid = await makeCid(block);
    const putBlock = vi.fn();
    const fq = createQueue();

    const handler = createGossipHandler({
      topic: TOPIC,
      ipnsName: IPNS_NAME,
      factQueue: fq,
      putBlock,
    });

    handler(
      makeEvent(TOPIC, {
        ipnsName: IPNS_NAME,
        cid: cid.toString(),
        seq: 1,
      }),
    );

    expect(putBlock).not.toHaveBeenCalled();
    // gossip-message + cid-discovered
    expect(fq.items.length).toBeGreaterThanOrEqual(2);
  });
});
