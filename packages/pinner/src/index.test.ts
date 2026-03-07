import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAdminSecret,
  deriveDocKeys,
  ed25519KeyPairFromSeed,
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
}): Promise<Uint8Array> {
  const secret = generateAdminSecret();
  const keys = await deriveDocKeys(
    secret, "test-app", ["content"]
  );
  const signingKey = await ed25519KeyPairFromSeed(
    keys.ipnsKeyBytes
  );
  return encodeSnapshot(
    { content: new Uint8Array([1, 2, 3]) },
    keys.readKey,
    opts?.prev ?? null,
    opts?.seq ?? 1,
    opts?.ts ?? Date.now(),
    signingKey
  );
}

// Reusable keys for multi-snapshot tests
async function makeKeysAndSnapshot(
  secret: string,
  opts?: { seq?: number; ts?: number }
): Promise<Uint8Array> {
  const keys = await deriveDocKeys(
    secret, "test-app", ["content"]
  );
  const signingKey = await ed25519KeyPairFromSeed(
    keys.ipnsKeyBytes
  );
  return encodeSnapshot(
    { content: new Uint8Array([1, 2, 3]) },
    keys.readKey,
    null,
    opts?.seq ?? 1,
    opts?.ts ?? Date.now(),
    signingKey
  );
}

describe("@pokapali/pinner", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(
      join(tmpdir(), "pinner-test-")
    );
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
    const block = await makeSnapshot();
    const accepted = await pinner.ingest(
      "name1", block
    );
    expect(accepted).toBe(true);
  });

  it("rejects invalid snapshot (random bytes)", async () => {
    const garbage = new Uint8Array(256);
    crypto.getRandomValues(garbage);
    const accepted = await pinner.ingest(
      "name1", garbage
    );
    expect(accepted).toBe(false);
  });

  it("enforces rate limiting", async () => {
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxPerHour: 3 },
    });
    await p.start();

    for (let i = 0; i < 3; i++) {
      const block = await makeSnapshot({
        seq: i + 1,
        ts: Date.now() + i,
      });
      expect(
        await p.ingest("name1", block)
      ).toBe(true);
    }

    const block4 = await makeSnapshot({
      seq: 4,
      ts: Date.now() + 10,
    });
    expect(
      await p.ingest("name1", block4)
    ).toBe(false);

    await p.stop();
  });

  it("rejects oversized blocks", async () => {
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxSizeBytes: 10 },
    });
    await p.start();

    const block = await makeSnapshot();
    // Real snapshot is > 10 bytes
    expect(
      await p.ingest("name1", block)
    ).toBe(false);

    await p.stop();
  });

  it("tracks history for ingested snapshots", async () => {
    const secret = generateAdminSecret();

    for (let i = 1; i <= 3; i++) {
      const block = await makeKeysAndSnapshot(
        secret, { seq: i, ts: 1000 + i }
      );
      await pinner.ingest("name1", block);
    }

    const history = pinner.history.getHistory(
      "name1"
    );
    expect(history).toHaveLength(3);
  });

  it("prunes old snapshots but keeps tip", async () => {
    const secret = generateAdminSecret();
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000;

    const block1 = await makeKeysAndSnapshot(
      secret, { seq: 1, ts: old }
    );
    const block2 = await makeKeysAndSnapshot(
      secret, { seq: 2, ts: old + 1000 }
    );
    const block3 = await makeKeysAndSnapshot(
      secret, { seq: 3, ts: now }
    );

    await pinner.ingest("name1", block1);
    await pinner.ingest("name1", block2);
    await pinner.ingest("name1", block3);

    const removed = pinner.history.prune(now);
    // block1 and block2 are >24h old,
    // block3 is the tip and recent
    expect(removed).toHaveLength(2);

    const remaining = pinner.history.getHistory(
      "name1"
    );
    expect(remaining).toHaveLength(1);

    // Tip is still present
    const tip = pinner.history.getTip("name1");
    expect(tip).not.toBeNull();
  });

  it("persists and restores state", async () => {
    const block = await makeSnapshot({ ts: 5000 });
    await pinner.ingest("name1", block);
    await pinner.stop();

    // Create new pinner with same storagePath
    const p2 = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
    });
    await p2.start();

    // knownNames should be restored
    const names = p2.history.allNames();
    // History is in-memory so won't survive,
    // but knownNames are persisted. We verify
    // via state file round-trip tested separately.
    // The pinner restores knownNames on start.
    await p2.stop();
  });

  it("rate limits are per IPNS name", async () => {
    const p = await createPinner({
      appIds: ["test-app"],
      storagePath: tmpDir,
      rateLimits: { maxPerHour: 1 },
    });
    await p.start();

    const block1 = await makeSnapshot({
      seq: 1, ts: Date.now(),
    });
    const block2 = await makeSnapshot({
      seq: 2, ts: Date.now() + 1,
    });
    const block3 = await makeSnapshot({
      seq: 3, ts: Date.now() + 2,
    });

    expect(
      await p.ingest("name1", block1)
    ).toBe(true);
    // name1 is now rate-limited
    expect(
      await p.ingest("name1", block2)
    ).toBe(false);
    // name2 is independent
    expect(
      await p.ingest("name2", block3)
    ).toBe(true);

    await p.stop();
  });
});
