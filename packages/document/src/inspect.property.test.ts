/**
 * Property tests for inspect({ upTo }) prefix
 * evaluation.
 *
 * Verifies:
 * - Prefix equivalence: inspect(view, doc, { upTo: k })
 *   equals inspect over a document with only the first
 *   k epochs.
 * - Monotonicity: larger upTo never decreases the
 *   result (for a monotone measure like edit count).
 * - Boundary: upTo 0 returns monoid empty; upTo >= n
 *   equals full inspect.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Measured } from "@pokapali/finger-tree";
import { inspect } from "./inspect.js";
import { Document } from "./document/document.js";
import { View } from "./view.js";
import { Epoch, Boundary, Edit } from "./history/index.js";
import { generateIdentityKeypair } from "@pokapali/crypto";
import type { Capability } from "./capability/capability.js";

// --- Helpers ---

const countMeasured: Measured<number, Epoch> = {
  monoid: {
    empty: 0,
    append: (a, b) => a + b,
  },
  measure: (ep) => ep.edits.length,
};

function countView(channel: string): View<number> {
  return View.singleChannel({
    name: "edit-count",
    description: "Count of edits",
    channel,
    measured: countMeasured,
  });
}

function makeEdit(n: number, channel: string): Edit {
  return Edit.create({
    payload: new Uint8Array([n]),
    timestamp: n * 1000,
    author: "alice",
    channel,
    origin: "local",
    signature: new Uint8Array(),
  });
}

const fakeCap: Capability = {
  channels: new Set(["content"]),
  canPushSnapshots: false,
  isAdmin: false,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeCodec: any = {
  merge: () => new Uint8Array(),
  diff: () => new Uint8Array(),
  clockSum: () => 0,
  createSurface: () => ({
    handle: {},
    applyEdit: () => {},
    applyState: () => {},
    onLocalEdit: () => () => {},
    destroy: () => {},
  }),
};

/**
 * Build a document with `epochCount` closed epochs,
 * each containing `editsPerEpoch` edits, plus one
 * final open epoch with `editsPerEpoch` edits.
 */
async function makeDocument(
  epochCount: number,
  editsPerEpoch: number,
): Promise<Document> {
  const identity = await generateIdentityKeypair();
  const doc = Document.create({
    identity,
    capability: fakeCap,
    codec: fakeCodec,
  });

  const ch = doc.channel("content");
  let editId = 0;

  for (let e = 0; e < epochCount; e++) {
    for (let i = 0; i < editsPerEpoch; i++) {
      ch.appendEdit(makeEdit(editId++, "content"));
    }
    if (e < epochCount - 1) {
      ch.closeEpoch();
    }
  }

  return doc;
}

/**
 * Build a document from explicit epoch sizes.
 * All but the last epoch are closed; last is open.
 */
async function makeDocumentFromSizes(sizes: number[]): Promise<Document> {
  const identity = await generateIdentityKeypair();
  const doc = Document.create({
    identity,
    capability: fakeCap,
    codec: fakeCodec,
  });

  const ch = doc.channel("content");
  let editId = 0;

  for (let e = 0; e < sizes.length; e++) {
    for (let i = 0; i < sizes[e]!; i++) {
      ch.appendEdit(makeEdit(editId++, "content"));
    }
    if (e < sizes.length - 1) {
      ch.closeEpoch();
    }
  }

  return doc;
}

// --- Arbitraries ---

/**
 * Arbitrary list of epoch sizes (1–5 epochs, each
 * with 1–4 edits).
 */
function arbEpochSizes(): fc.Arbitrary<number[]> {
  return fc.array(fc.integer({ min: 1, max: 4 }), {
    minLength: 1,
    maxLength: 5,
  });
}

// --- Property tests ---

describe("inspect({ upTo }) properties", () => {
  it(
    "prefix equivalence: upTo k equals " + "inspect over first k epochs",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbEpochSizes(), async (sizes) => {
          const doc = await makeDocumentFromSizes(sizes);
          const v = countView("content");
          const totalEpochs = sizes.length;

          for (let k = 0; k <= totalEpochs; k++) {
            const prefixResult = inspect(v, doc, { upTo: k });

            // Expected: sum of first k epoch sizes
            const expected = sizes.slice(0, k).reduce((a, b) => a + b, 0);

            expect(prefixResult).toBe(expected);
          }
        }),
        { numRuns: 50 },
      );
    },
  );

  it("monotonicity: larger upTo never " + "decreases result", async () => {
    await fc.assert(
      fc.asyncProperty(arbEpochSizes(), async (sizes) => {
        const doc = await makeDocumentFromSizes(sizes);
        const v = countView("content");
        const totalEpochs = sizes.length;

        let prev = 0;
        for (let k = 0; k <= totalEpochs; k++) {
          const result = inspect(v, doc, { upTo: k });
          expect(result).toBeGreaterThanOrEqual(prev);
          prev = result;
        }
      }),
      { numRuns: 50 },
    );
  });

  it("boundary: upTo 0 is monoid empty", async () => {
    await fc.assert(
      fc.asyncProperty(arbEpochSizes(), async (sizes) => {
        const doc = await makeDocumentFromSizes(sizes);
        const v = countView("content");
        expect(inspect(v, doc, { upTo: 0 })).toBe(0);
      }),
      { numRuns: 50 },
    );
  });

  it("boundary: upTo >= epoch count equals " + "full inspect", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEpochSizes(),
        fc.integer({ min: 0, max: 20 }),
        async (sizes, extra) => {
          const doc = await makeDocumentFromSizes(sizes);
          const v = countView("content");
          const full = inspect(v, doc);
          const large = inspect(v, doc, { upTo: sizes.length + extra });
          expect(large).toBe(full);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("idempotence: upTo n twice gives " + "same result", async () => {
    await fc.assert(
      fc.asyncProperty(arbEpochSizes(), async (sizes) => {
        const doc = await makeDocumentFromSizes(sizes);
        const v = countView("content");
        const k = Math.min(2, sizes.length);
        const a = inspect(v, doc, { upTo: k });
        const b = inspect(v, doc, { upTo: k });
        expect(a).toBe(b);
      }),
      { numRuns: 50 },
    );
  });
});
