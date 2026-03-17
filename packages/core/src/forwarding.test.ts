import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createForwardingRecord,
  encodeForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import { generateAdminSecret, deriveDocKeys } from "@pokapali/crypto";

describe("forwarding records", () => {
  let rotationKey: Uint8Array;

  beforeEach(async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(secret, "test", ["content"]);
    rotationKey = keys.rotationKey;
  });

  // ── createForwardingRecord ─────────────────────

  it("creates a record with correct fields", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    expect(record.oldIpnsName).toBe("oldName");
    expect(record.newIpnsName).toBe("newName");
    expect(record.newUrl).toBe("https://example.com/doc/newName#frag");
    expect(record.signature).toBeInstanceOf(Uint8Array);
    expect(record.signature.length).toBeGreaterThan(0);
  });

  it("different inputs produce different signatures", async () => {
    const r1 = await createForwardingRecord(
      "old1",
      "new1",
      "https://a.com",
      rotationKey,
    );
    const r2 = await createForwardingRecord(
      "old2",
      "new2",
      "https://b.com",
      rotationKey,
    );
    expect(r1.signature).not.toEqual(r2.signature);
  });

  // ── encode / decode ────────────────────────────

  it("encode/decode round-trip", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    const bytes = encodeForwardingRecord(record);
    const decoded = decodeForwardingRecord(bytes);

    expect(decoded.oldIpnsName).toBe("oldName");
    expect(decoded.newIpnsName).toBe("newName");
    expect(decoded.newUrl).toBe("https://example.com/doc/newName#frag");
    expect(decoded.signature).toBeInstanceOf(Uint8Array);
  });

  it("encoded bytes are valid DAG-CBOR", async () => {
    const record = await createForwardingRecord(
      "a",
      "b",
      "https://c.com",
      rotationKey,
    );
    const bytes = encodeForwardingRecord(record);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // Should decode without throwing
    const decoded = decodeForwardingRecord(bytes);
    expect(decoded).toHaveProperty("oldIpnsName");
    expect(decoded).toHaveProperty("newIpnsName");
    expect(decoded).toHaveProperty("newUrl");
    expect(decoded).toHaveProperty("signature");
  });

  it("decode throws on garbage bytes", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(() => decodeForwardingRecord(garbage)).toThrow();
  });

  it("decode throws on empty bytes", () => {
    expect(() => decodeForwardingRecord(new Uint8Array(0))).toThrow();
  });

  // ── verifyForwardingRecord ─────────────────────

  it("verify valid signature", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    const valid = await verifyForwardingRecord(record, rotationKey);
    expect(valid).toBe(true);
  });

  it("reject tampered newUrl", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    record.newUrl = "https://evil.com/doc/newName#frag";
    const valid = await verifyForwardingRecord(record, rotationKey);
    expect(valid).toBe(false);
  });

  it("reject tampered oldIpnsName", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    record.oldIpnsName = "differentOldName";
    const valid = await verifyForwardingRecord(record, rotationKey);
    expect(valid).toBe(false);
  });

  it("reject tampered newIpnsName", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    record.newIpnsName = "differentNewName";
    const valid = await verifyForwardingRecord(record, rotationKey);
    expect(valid).toBe(false);
  });

  it("reject corrupted signature", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    // Flip a byte in the signature
    record.signature = new Uint8Array(record.signature);
    record.signature[0] ^= 0xff;
    const valid = await verifyForwardingRecord(record, rotationKey);
    expect(valid).toBe(false);
  });

  it("reject wrong rotation key", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    const otherSecret = generateAdminSecret();
    const otherKeys = await deriveDocKeys(otherSecret, "test", ["content"]);
    const valid = await verifyForwardingRecord(record, otherKeys.rotationKey);
    expect(valid).toBe(false);
  });

  it("returns false for malformed record", async () => {
    const bad = {
      oldIpnsName: "x",
      newIpnsName: "y",
      newUrl: "z",
      signature: new Uint8Array(10),
    };
    const valid = await verifyForwardingRecord(bad, rotationKey);
    expect(valid).toBe(false);
  });

  // ── store / lookup ─────────────────────────────

  describe("forwarding store", () => {
    let mod: typeof import("./forwarding.js");

    beforeEach(async () => {
      vi.resetModules();
      mod = await import("./forwarding.js");
    });

    it("store and lookup a record", async () => {
      const record = await createForwardingRecord(
        "oldName",
        "newName",
        "https://example.com",
        rotationKey,
      );
      const bytes = encodeForwardingRecord(record);
      mod.storeForwardingRecord("oldName", bytes);

      const found = mod.lookupForwardingRecord("oldName");
      expect(found).toEqual(bytes);
    });

    it("lookup returns undefined for unknown key", () => {
      const found = mod.lookupForwardingRecord("unknown");
      expect(found).toBeUndefined();
    });

    it("overwrite replaces previous record", async () => {
      const r1 = await createForwardingRecord(
        "old",
        "new1",
        "https://a.com",
        rotationKey,
      );
      const r2 = await createForwardingRecord(
        "old",
        "new2",
        "https://b.com",
        rotationKey,
      );
      const b1 = encodeForwardingRecord(r1);
      const b2 = encodeForwardingRecord(r2);

      mod.storeForwardingRecord("old", b1);
      mod.storeForwardingRecord("old", b2);

      const found = mod.lookupForwardingRecord("old");
      expect(found).toEqual(b2);
    });

    it("multiple records coexist", async () => {
      const r1 = await createForwardingRecord(
        "old1",
        "new1",
        "https://a.com",
        rotationKey,
      );
      const r2 = await createForwardingRecord(
        "old2",
        "new2",
        "https://b.com",
        rotationKey,
      );
      mod.storeForwardingRecord("old1", encodeForwardingRecord(r1));
      mod.storeForwardingRecord("old2", encodeForwardingRecord(r2));

      const f1 = mod.lookupForwardingRecord("old1");
      const f2 = mod.lookupForwardingRecord("old2");
      expect(f1).toBeDefined();
      expect(f2).toBeDefined();

      const d1 = decodeForwardingRecord(f1!);
      const d2 = decodeForwardingRecord(f2!);
      expect(d1.newIpnsName).toBe("new1");
      expect(d2.newIpnsName).toBe("new2");
    });
  });
});
