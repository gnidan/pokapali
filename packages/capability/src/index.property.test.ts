/**
 * Property-based tests for @pokapali/capability.
 *
 * Verifies round-trip, monotonicity, and lattice
 * invariants for the capability encoding and
 * narrowing logic.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  encodeFragment,
  decodeFragment,
  inferCapability,
  narrowCapability,
  buildUrl,
  parseUrl,
} from "./index.js";
import type { CapabilityKeys } from "./index.js";
import { generateAdminSecret, deriveDocKeys } from "@pokapali/crypto";

// ------------------------------------------------
// Helpers
// ------------------------------------------------

/**
 * Generate real CapabilityKeys from random secrets.
 * Uses deriveDocKeys to get properly typed CryptoKey
 * objects (cannot use arbitrary bytes for AES-GCM).
 */
async function realKeys(channels: string[]): Promise<Required<CapabilityKeys>> {
  const secret = generateAdminSecret();
  const dk = await deriveDocKeys(secret, "test", channels);
  return {
    readKey: dk.readKey,
    ipnsKeyBytes: dk.ipnsKeyBytes,
    rotationKey: dk.rotationKey,
    awarenessRoomPassword: dk.awarenessRoomPassword,
    channelKeys: dk.channelKeys,
  };
}

// ------------------------------------------------
// encodeFragment / decodeFragment round-trip
// ------------------------------------------------

describe("encodeFragment / decodeFragment properties", () => {
  it("full-key round-trip preserves all fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,8}$/), {
          minLength: 1,
          maxLength: 4,
        }),
        async (channels) => {
          const unique = [...new Set(channels)];
          const keys = await realKeys(unique);

          const fragment = await encodeFragment(keys);
          const decoded = await decodeFragment(fragment);

          // readKey round-trips (compare raw bytes)
          const origRaw = new Uint8Array(
            await crypto.subtle.exportKey("raw", keys.readKey),
          );
          const decRaw = new Uint8Array(
            await crypto.subtle.exportKey("raw", decoded.readKey!),
          );
          expect(decRaw).toEqual(origRaw);

          expect(decoded.ipnsKeyBytes).toEqual(keys.ipnsKeyBytes);
          expect(decoded.rotationKey).toEqual(keys.rotationKey);
          expect(decoded.awarenessRoomPassword).toBe(
            keys.awarenessRoomPassword,
          );

          for (const ch of unique) {
            expect(decoded.channelKeys![ch]).toEqual(keys.channelKeys[ch]);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("partial keys round-trip (read-only)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const full = await realKeys(["content"]);
        const partial: CapabilityKeys = {
          readKey: full.readKey,
          awarenessRoomPassword: full.awarenessRoomPassword,
        };

        const fragment = await encodeFragment(partial);
        const decoded = await decodeFragment(fragment);

        expect(decoded.readKey).toBeDefined();
        expect(decoded.ipnsKeyBytes).toBeUndefined();
        expect(decoded.rotationKey).toBeUndefined();
        expect(decoded.channelKeys).toBeUndefined();
      }),
      { numRuns: 5 },
    );
  });

  it("encode output is valid base64url", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), {
          minLength: 0,
          maxLength: 3,
        }),
        async (channels) => {
          const unique = [...new Set(channels)];
          const keys = await realKeys(unique.length > 0 ? unique : ["x"]);
          const fragment = await encodeFragment(keys);
          expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("encode is deterministic", async () => {
    const keys = await realKeys(["a", "b"]);
    const f1 = await encodeFragment(keys);
    const f2 = await encodeFragment(keys);
    expect(f1).toBe(f2);
  });
});

// ------------------------------------------------
// inferCapability
// ------------------------------------------------

describe("inferCapability properties", () => {
  it("isAdmin iff rotationKey present", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (includeRotation) => {
        const full = await realKeys(["content"]);
        const keys: CapabilityKeys = {
          readKey: full.readKey,
          channelKeys: full.channelKeys,
          rotationKey: includeRotation ? full.rotationKey : undefined,
        };
        const cap = inferCapability(keys, ["content"]);
        expect(cap.isAdmin).toBe(includeRotation);
      }),
      { numRuns: 10 },
    );
  });

  it("canPushSnapshots iff ipnsKeyBytes present", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (includeIpns) => {
        const full = await realKeys(["content"]);
        const keys: CapabilityKeys = {
          readKey: full.readKey,
          channelKeys: full.channelKeys,
          ipnsKeyBytes: includeIpns ? full.ipnsKeyBytes : undefined,
        };
        const cap = inferCapability(keys, ["content"]);
        expect(cap.canPushSnapshots).toBe(includeIpns);
      }),
      { numRuns: 10 },
    );
  });

  it("channels ⊆ requested channels", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), {
          minLength: 0,
          maxLength: 5,
        }),
        async (keyChs, reqChs) => {
          const uniqueKeyChs = [...new Set(keyChs)];
          const full = await realKeys(uniqueKeyChs);
          const cap = inferCapability(full, reqChs);
          for (const ch of cap.channels) {
            expect(reqChs).toContain(ch);
            expect(ch in full.channelKeys!).toBe(true);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ------------------------------------------------
// narrowCapability
// ------------------------------------------------

describe("narrowCapability properties", () => {
  it("narrowed keys never include rotationKey", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.subarray(["a", "b", "c"], {
          minLength: 0,
          maxLength: 3,
        }),
        async (canPush, grantChs) => {
          const full = await realKeys(["a", "b", "c"]);
          const narrowed = narrowCapability(full, {
            canPushSnapshots: canPush,
            channels: grantChs,
          });
          expect(narrowed.rotationKey).toBeUndefined();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("readKey and awarenessRoomPassword always " + "preserved", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (canPush) => {
        const full = await realKeys(["x"]);
        const narrowed = narrowCapability(full, {
          canPushSnapshots: canPush,
          channels: [],
        });
        expect(narrowed.readKey).toBeDefined();
        expect(narrowed.awarenessRoomPassword).toBe(full.awarenessRoomPassword);
      }),
      { numRuns: 10 },
    );
  });

  it("ipnsKeyBytes only if canPushSnapshots " + "granted", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (canPush) => {
        const full = await realKeys(["x"]);
        const narrowed = narrowCapability(full, {
          canPushSnapshots: canPush,
          channels: ["x"],
        });
        if (canPush) {
          expect(narrowed.ipnsKeyBytes).toEqual(full.ipnsKeyBytes);
        } else {
          expect(narrowed.ipnsKeyBytes).toBeUndefined();
        }
      }),
      { numRuns: 10 },
    );
  });

  it("narrowed channelKeys ⊆ original channelKeys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(["a", "b", "c", "d"], {
          minLength: 0,
          maxLength: 4,
        }),
        async (grantChs) => {
          const full = await realKeys(["a", "b", "c", "d"]);
          const narrowed = narrowCapability(full, {
            canPushSnapshots: false,
            channels: grantChs,
          });
          if (narrowed.channelKeys) {
            for (const ch of Object.keys(narrowed.channelKeys)) {
              expect(grantChs).toContain(ch);
              expect(narrowed.channelKeys[ch]).toEqual(full.channelKeys[ch]);
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ------------------------------------------------
// buildUrl / parseUrl round-trip
// ------------------------------------------------

describe("buildUrl / parseUrl properties", () => {
  it("round-trip preserves base, ipnsName, keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^https:\/\/[a-z]{3,10}\.[a-z]{2,4}$/),
        fc.stringMatching(/^[a-z0-9-]{8,20}$/),
        async (base, ipnsName) => {
          const keys = await realKeys(["content"]);
          const url = await buildUrl(base, ipnsName, keys);
          const parsed = await parseUrl(url);

          expect(parsed.base).toBe(base);
          expect(parsed.ipnsName).toBe(ipnsName);

          // Compare readKey bytes
          const origRaw = new Uint8Array(
            await crypto.subtle.exportKey("raw", keys.readKey),
          );
          const parsedRaw = new Uint8Array(
            await crypto.subtle.exportKey("raw", parsed.keys.readKey!),
          );
          expect(parsedRaw).toEqual(origRaw);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("trailing slash in base is normalized", async () => {
    const keys = await realKeys(["x"]);
    const url1 = await buildUrl("https://example.com", "test", keys);
    const url2 = await buildUrl("https://example.com/", "test", keys);
    // Both should produce the same URL path
    const path1 = url1.split("#")[0];
    const path2 = url2.split("#")[0];
    expect(path1).toBe(path2);
  });
});

// ------------------------------------------------
// narrowCapability monotonicity via inferCapability
// ------------------------------------------------

describe("narrowCapability monotonicity", () => {
  it(
    "narrowed capability permissions are a " + "subset of original",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.subarray(["a", "b", "c", "d"], {
            minLength: 0,
            maxLength: 4,
          }),
          fc.boolean(),
          async (grantChs, canPush) => {
            const allChs = ["a", "b", "c", "d"];
            const full = await realKeys(allChs);
            const narrowed = narrowCapability(full, {
              canPushSnapshots: canPush,
              channels: grantChs,
            });

            const origCap = inferCapability(full, allChs);
            const narrowedCap = inferCapability(narrowed, allChs);

            // narrowed channels ⊆ original channels
            for (const ch of narrowedCap.channels) {
              expect(origCap.channels.has(ch)).toBe(true);
            }

            // narrowed can never gain admin
            if (!origCap.isAdmin) {
              expect(narrowedCap.isAdmin).toBe(false);
            }
            // narrowed never has admin (rotationKey
            // is always stripped)
            expect(narrowedCap.isAdmin).toBe(false);

            // canPushSnapshots only if granted AND
            // original had it
            if (!origCap.canPushSnapshots || !canPush) {
              expect(narrowedCap.canPushSnapshots).toBe(false);
            }
          },
        ),
        { numRuns: 20 },
      );
    },
  );

  it(
    "double-narrow produces same capability " + "as single narrow",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.subarray(["a", "b", "c"], {
            minLength: 0,
            maxLength: 3,
          }),
          fc.boolean(),
          async (grantChs, canPush) => {
            const full = await realKeys(["a", "b", "c"]);
            const grant = {
              canPushSnapshots: canPush,
              channels: grantChs,
            };

            const once = narrowCapability(full, grant);
            const twice = narrowCapability(once, grant);

            const allChs = ["a", "b", "c"];
            const onceCap = inferCapability(once, allChs);
            const twiceCap = inferCapability(twice, allChs);

            expect(twiceCap.isAdmin).toBe(onceCap.isAdmin);
            expect(twiceCap.canPushSnapshots).toBe(onceCap.canPushSnapshots);
            expect([...twiceCap.channels].sort()).toEqual(
              [...onceCap.channels].sort(),
            );
          },
        ),
        { numRuns: 20 },
      );
    },
  );

  it("narrowing with empty grant strips " + "channels and push", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,4}$/), {
          minLength: 1,
          maxLength: 3,
        }),
        async (channels) => {
          const unique = [...new Set(channels)];
          const full = await realKeys(unique);
          const narrowed = narrowCapability(full, {
            canPushSnapshots: false,
            channels: [],
          });

          expect(narrowed.ipnsKeyBytes).toBeUndefined();
          expect(narrowed.rotationKey).toBeUndefined();
          expect(narrowed.channelKeys).toBeUndefined();
          // readKey and password preserved
          expect(narrowed.readKey).toBeDefined();
          expect(narrowed.awarenessRoomPassword).toBeDefined();
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ------------------------------------------------
// Encoding canonical form
// ------------------------------------------------

describe("encoding canonical form", () => {
  it("entries are sorted by label in wire " + "format", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z]{1,6}$/), {
          minLength: 2,
          maxLength: 5,
        }),
        async (channels) => {
          const unique = [...new Set(channels)];
          if (unique.length < 2) return;

          const keys = await realKeys(unique);
          const fragment = await encodeFragment(keys);

          // Encode twice with shuffled channel
          // order — should produce same output
          const shuffled: CapabilityKeys = {
            ...keys,
            channelKeys: Object.fromEntries(
              Object.entries(keys.channelKeys!).reverse(),
            ),
          };
          const fragment2 = await encodeFragment(shuffled);
          expect(fragment2).toBe(fragment);
        },
      ),
      { numRuns: 15 },
    );
  });

  it(
    "round-trip preserves keys regardless of " + "channel name order",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(["alpha", "beta", "gamma", "delta"], {
            minLength: 2,
            maxLength: 4,
          }),
          async (channels) => {
            const keys = await realKeys(channels);
            const fragment = await encodeFragment(keys);
            const decoded = await decodeFragment(fragment);

            for (const ch of channels) {
              expect(decoded.channelKeys![ch]).toEqual(keys.channelKeys[ch]);
            }
          },
        ),
        { numRuns: 15 },
      );
    },
  );
});
