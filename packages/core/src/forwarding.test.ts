import { describe, it, expect, beforeEach } from "vitest";
import {
  createForwardingRecord,
  encodeForwardingRecord,
  decodeForwardingRecord,
  verifyForwardingRecord,
} from "./forwarding.js";
import {
  generateAdminSecret,
  deriveDocKeys,
} from "@pokapali/crypto";

describe("forwarding records", () => {
  let rotationKey: Uint8Array;

  beforeEach(async () => {
    const secret = generateAdminSecret();
    const keys = await deriveDocKeys(
      secret,
      "test",
      ["content"],
    );
    rotationKey = keys.rotationKey;
  });

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
    expect(decoded.newUrl).toBe(
      "https://example.com/doc/newName#frag",
    );
    expect(decoded.signature).toBeInstanceOf(
      Uint8Array,
    );
  });

  it("verify valid signature", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    const valid = await verifyForwardingRecord(
      record,
      rotationKey,
    );
    expect(valid).toBe(true);
  });

  it("reject tampered record", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    // Tamper with the new URL
    record.newUrl =
      "https://evil.com/doc/newName#frag";
    const valid = await verifyForwardingRecord(
      record,
      rotationKey,
    );
    expect(valid).toBe(false);
  });

  it("reject wrong rotation key", async () => {
    const record = await createForwardingRecord(
      "oldName",
      "newName",
      "https://example.com/doc/newName#frag",
      rotationKey,
    );
    // Use a different rotation key
    const otherSecret = generateAdminSecret();
    const otherKeys = await deriveDocKeys(
      otherSecret,
      "test",
      ["content"],
    );
    const valid = await verifyForwardingRecord(
      record,
      otherKeys.rotationKey,
    );
    expect(valid).toBe(false);
  });
});
