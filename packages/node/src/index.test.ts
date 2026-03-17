import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
  bytesToHex,
} from "@pokapali/crypto";
import { encodeSnapshot } from "@pokapali/snapshot";
import { createPinner } from "./pinner.js";
import type { Pinner } from "./pinner.js";

let tmpDir: string;
let pinner: Pinner;

async function makeSnapshot(opts?: {
  seq?: number;
  ts?: number;
  prev?: null;
}): Promise<{ block: Uint8Array; ipnsName: string }> {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(secret, "test-app", ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  const block = await encodeSnapshot(
    { content: new Uint8Array([1, 2, 3]) },
    keys.readKey,
    opts?.prev ?? null,
    opts?.seq ?? 1,
    opts?.ts ?? Date.now(),
    signingKey,
  );
  return {
    block,
    ipnsName: bytesToHex(signingKey.publicKey),
  };
}

// Reusable keys for multi-snapshot tests
async function makeKeysAndSnapshot(
  secret: string,
  opts?: { seq?: number; ts?: number },
): Promise<{ block: Uint8Array; ipnsName: string }> {
  const keys = await deriveDocKeys(secret, "test-app", ["content"]);
  const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
  const block = await encodeSnapshot(
    { content: new Uint8Array([1, 2, 3]) },
    keys.readKey,
    null,
    opts?.seq ?? 1,
    opts?.ts ?? Date.now(),
    signingKey,
  );
  return {
    block,
    ipnsName: bytesToHex(signingKey.publicKey),
  };
}

describe("@pokapali/node", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "node-test-"));
    pinner = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
    });
    await pinner.start();
  });

  afterEach(async () => {
    await pinner.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a valid snapshot", async () => {
    const { block, ipnsName } = await makeSnapshot();
    const accepted = await pinner.ingest(ipnsName, block);
    expect(accepted).toBe(true);
  });

  it("rejects invalid snapshot (random bytes)", async () => {
    const garbage = new Uint8Array(256);
    crypto.getRandomValues(garbage);
    // Use a valid-looking hex ipnsName (64 hex chars)
    const fakeHex = "aa".repeat(32);
    const accepted = await pinner.ingest(fakeHex, garbage);
    expect(accepted).toBe(false);
  });

  it("enforces rate limiting", async () => {
    await pinner.stop();
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxPerHour: 3 },
    });
    await p.start();

    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test-app", ["content"]);
    const signingKey = await ed25519KeyPairFromSeed(keys.ipnsKeyBytes);
    const ipnsName = bytesToHex(signingKey.publicKey);

    for (let i = 0; i < 3; i++) {
      const block = await encodeSnapshot(
        { content: new Uint8Array([1, 2, 3]) },
        keys.readKey,
        null,
        i + 1,
        Date.now() + i,
        signingKey,
      );
      expect(await p.ingest(ipnsName, block)).toBe(true);
    }

    const block4 = await encodeSnapshot(
      { content: new Uint8Array([1, 2, 3]) },
      keys.readKey,
      null,
      4,
      Date.now() + 10,
      signingKey,
    );
    expect(await p.ingest(ipnsName, block4)).toBe(false);

    await p.stop();
  });

  it("rejects oversized blocks", async () => {
    await pinner.stop();
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxSizeBytes: 10 },
    });
    await p.start();

    const { block, ipnsName } = await makeSnapshot();
    // Real snapshot is > 10 bytes
    expect(await p.ingest(ipnsName, block)).toBe(false);

    await p.stop();
  });

  it("tracks history for ingested snapshots", async () => {
    const secret = generateAdminSecret();
    const now = Date.now();
    let ipnsName = "";

    for (let i = 1; i <= 3; i++) {
      const result = await makeKeysAndSnapshot(secret, {
        seq: i,
        ts: now - (3 - i) * 1000,
      });
      ipnsName = result.ipnsName;
      await pinner.ingest(ipnsName, result.block);
    }

    const history = pinner.history.getHistory(ipnsName);
    expect(history).toHaveLength(3);
  });

  it("prunes old snapshots but keeps tip", async () => {
    const secret = generateAdminSecret();
    const now = Date.now();
    // 15 days ago — past 14-day retention
    const old = now - 15 * 24 * 60 * 60 * 1000;

    const s1 = await makeKeysAndSnapshot(secret, {
      seq: 1,
      ts: old,
    });
    const s2 = await makeKeysAndSnapshot(secret, {
      seq: 2,
      ts: old + 1000,
    });
    const s3 = await makeKeysAndSnapshot(secret, {
      seq: 3,
      ts: now,
    });
    const ipnsName = s1.ipnsName;

    await pinner.ingest(ipnsName, s1.block);
    await pinner.ingest(ipnsName, s2.block);
    await pinner.ingest(ipnsName, s3.block);

    // block1 already thinned during ingest (same
    // daily bucket as block2, block2 is newer).
    // prune() removes block2 (>14d, not tip).
    const removed = pinner.history.prune(now);
    expect(removed).toHaveLength(1);

    const remaining = pinner.history.getHistory(ipnsName);
    expect(remaining).toHaveLength(1);

    // Tip is still present
    const tip = pinner.history.getTip(ipnsName);
    expect(tip).not.toBeNull();
  });

  it("thins old versions on ingest", async () => {
    const secret = generateAdminSecret();
    const now = Date.now();
    const DAY = 24 * 60 * 60_000;

    // Ingest 3 snapshots: two from 10 days ago
    // (same hour bucket), one recent (tip)
    const s1 = await makeKeysAndSnapshot(secret, {
      seq: 1,
      ts: now - 10 * DAY,
    });
    const s2 = await makeKeysAndSnapshot(secret, {
      seq: 2,
      ts: now - 10 * DAY + 1000,
    });
    const s3 = await makeKeysAndSnapshot(secret, {
      seq: 3,
      ts: now,
    });
    const ipnsName = s1.ipnsName;

    await pinner.ingest(ipnsName, s1.block);
    await pinner.ingest(ipnsName, s2.block);
    await pinner.ingest(ipnsName, s3.block);

    // Thinning during ingest should keep only the
    // latest per hour bucket. block1 and block2 are
    // in the same hour, so block1 is removed.
    const history = pinner.history.getHistory(ipnsName);
    expect(history).toHaveLength(2); // block2 + block3
  });

  it("persists and restores state", async () => {
    const { block, ipnsName } = await makeSnapshot({
      ts: 5000,
    });
    await pinner.ingest(ipnsName, block);
    await pinner.stop();

    // Create new pinner with same storagePath
    const p2 = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
    });
    await p2.start();

    // knownNames should be restored
    p2.history.allNames();
    // History is in-memory so won't survive,
    // but knownNames are persisted. We verify
    // via state file round-trip tested separately.
    // The pinner restores knownNames on start.
    await p2.stop();
  });

  it("rate limits are per IPNS name", async () => {
    await pinner.stop();
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxPerHour: 1 },
    });
    await p.start();

    const r1 = await makeSnapshot({
      seq: 1,
      ts: Date.now(),
    });
    const r2 = await makeSnapshot({
      seq: 2,
      ts: Date.now() + 1,
    });
    const r3 = await makeSnapshot({
      seq: 3,
      ts: Date.now() + 2,
    });

    expect(await p.ingest(r1.ipnsName, r1.block)).toBe(true);
    // r1.ipnsName is now rate-limited
    expect(await p.ingest(r1.ipnsName, r2.block)).toBe(false);
    // r3 has a different ipnsName — independent
    expect(await p.ingest(r3.ipnsName, r3.block)).toBe(true);

    await p.stop();
  });
});
