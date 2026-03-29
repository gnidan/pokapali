/**
 * Reconciliation session state machine.
 *
 * Pure synchronous logic — no transport, no async.
 * Two sessions pass messages back and forth to
 * identify and exchange missing edits via Merkle
 * trie binary search.
 *
 * @module
 */

import {
  buildTrie,
  queryPrefix,
  collectHashes,
  type TrieNode,
} from "./merkle-trie.js";
import { type Message, MessageType } from "./messages.js";

// -------------------------------------------------------
// Types
// -------------------------------------------------------

type Edit = { payload: Uint8Array; signature: Uint8Array };

export interface ReconciliationSession {
  readonly sessionId: string;
  initiate(): Message;
  receive(msg: Message): Message | Edit[] | null;
}

// -------------------------------------------------------
// Constants
// -------------------------------------------------------

/** Max trie depth before falling back to EDIT_SET. */
const MAX_DEPTH = 16;

/**
 * If a subtree has this many or fewer edits, send
 * EDIT_SET directly instead of continuing the binary
 * search.
 */
const EDIT_SET_THRESHOLD = 10;

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Given a prefix and depth, find the next child
 * prefix to query by toggling through children.
 * Returns prefixes for left (bit=0) and right
 * (bit=1) children at the given depth.
 */
function childPrefix(
  prefix: Uint8Array,
  depth: number,
  bit: 0 | 1,
): Uint8Array {
  const out = new Uint8Array(prefix);
  const byteIndex = depth >>> 3;
  const bitOffset = 7 - (depth & 7);
  if (bit === 1) {
    out[byteIndex] = out[byteIndex]! | (1 << bitOffset);
  } else {
    out[byteIndex] = out[byteIndex]! & ~(1 << bitOffset);
  }
  return out;
}

// -------------------------------------------------------
// Session implementation
// -------------------------------------------------------

export function createSession(
  localHashes: Uint8Array[],
  localFingerprint: Uint8Array,
  channel: string,
  localSnapshot?: Uint8Array,
): ReconciliationSession {
  const sessionId = randomId();
  let trie: TrieNode | null = null;

  // Queue of pending trie queries (prefix, depth)
  // for the responder to work through.
  const queryQueue: Array<{
    prefix: Uint8Array;
    depth: number;
  }> = [];

  // Edits received from EDIT_BATCH messages,
  // buffered until the queue is fully drained.
  const receivedEdits: Edit[] = [];

  function ensureTrie(): TrieNode {
    if (trie === null) {
      trie = buildTrie(localHashes);
    }
    return trie;
  }

  function initiate(): Message {
    return {
      type: MessageType.RECONCILE_START,
      channel,
      fingerprint: localFingerprint,
      editCount: localHashes.length,
    };
  }

  function receive(msg: Message): Message | Edit[] | null {
    switch (msg.type) {
      case MessageType.RECONCILE_START:
        return handleReconcileStart(msg);
      case MessageType.TRIE_QUERY:
        return handleTrieQuery(msg);
      case MessageType.TRIE_RESPONSE:
        return handleTrieResponse(msg);
      case MessageType.EDIT_SET:
        return handleEditSet(msg);
      case MessageType.EDIT_BATCH: {
        receivedEdits.push(...msg.edits);
        // Continue exploring queued subtrees
        const next = drainQueue();
        if (next !== null) return next;
        // Queue empty — return all buffered edits
        return receivedEdits.length > 0 ? [...receivedEdits] : null;
      }
      case MessageType.FULL_STATE:
        return [
          {
            payload: msg.snapshot,
            signature: new Uint8Array(),
          },
        ];
    }
  }

  function handleReconcileStart(
    msg: Extract<Message, { type: typeof MessageType.RECONCILE_START }>,
  ): Message | null {
    // Already in sync — fingerprints AND edit counts
    // must both match. XOR fingerprint alone can't
    // distinguish "one all-zeros hash" from "no hashes"
    // since the zero hash is the XOR identity.
    if (
      bytesEqual(msg.fingerprint, localFingerprint) &&
      msg.editCount === localHashes.length
    ) {
      return null;
    }

    // Late joiner — send full state
    if (msg.editCount === 0 && localSnapshot) {
      return {
        type: MessageType.FULL_STATE,
        channel,
        snapshot: localSnapshot,
      };
    }

    // Start binary search
    const root = ensureTrie();
    const rootFP = root.kind === "leaf" ? root.hash : root.fingerprint;

    // Query root (depth 0)
    const rootEC = root.kind === "leaf" ? 1 : root.editCount;
    return {
      type: MessageType.TRIE_QUERY,
      channel,
      prefix: new Uint8Array(32),
      depth: 0,
      fingerprint: rootFP,
      editCount: rootEC,
    };
  }

  function handleTrieQuery(
    msg: Extract<Message, { type: typeof MessageType.TRIE_QUERY }>,
  ): Message {
    const root = ensureTrie();
    const local = queryPrefix(root, msg.prefix, msg.depth);

    // Both fingerprint AND editCount must match to
    // declare a subtree in sync. XOR fingerprint
    // alone can't distinguish "one all-zeros hash"
    // from "no hashes" (zero is the XOR identity).
    const match =
      bytesEqual(local.fingerprint, msg.fingerprint) &&
      local.editCount === msg.editCount;

    return {
      type: MessageType.TRIE_RESPONSE,
      channel,
      prefix: msg.prefix,
      depth: msg.depth,
      fingerprint: local.fingerprint,
      match,
    };
  }

  function handleTrieResponse(
    msg: Extract<Message, { type: typeof MessageType.TRIE_RESPONSE }>,
  ): Message | null {
    if (msg.match) {
      // Subtree matches — check queue for more
      return drainQueue();
    }

    // Mismatch — check if subtree is small enough
    // to send directly, or go deeper.
    const root = ensureTrie();
    const local = queryPrefix(root, msg.prefix, msg.depth);

    if (msg.depth < MAX_DEPTH && local.editCount > EDIT_SET_THRESHOLD) {
      // Large subtree — binary search deeper
      const leftPfx = childPrefix(msg.prefix, msg.depth, 0);
      const rightPfx = childPrefix(msg.prefix, msg.depth, 1);
      // Queue right, query left immediately
      queryQueue.push({
        prefix: rightPfx,
        depth: msg.depth + 1,
      });

      const leftLocal = queryPrefix(root, leftPfx, msg.depth + 1);

      return {
        type: MessageType.TRIE_QUERY,
        channel,
        prefix: leftPfx,
        depth: msg.depth + 1,
        fingerprint: leftLocal.fingerprint,
        editCount: leftLocal.editCount,
      };
    }

    // Small subtree or max depth — collect hashes
    const hashes = collectHashes(root, msg.prefix, msg.depth);

    return {
      type: MessageType.EDIT_SET,
      channel,
      prefix: msg.prefix,
      depth: msg.depth,
      hashes,
    };
  }

  function hexHash(h: Uint8Array): string {
    return Array.from(h)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function handleEditSet(
    msg: Extract<Message, { type: typeof MessageType.EDIT_SET }>,
  ): Message {
    // Scope to hashes in the same prefix range
    const root = ensureTrie();
    const localInRange = collectHashes(root, msg.prefix, msg.depth);

    const remoteSet = new Set(msg.hashes.map(hexHash));

    const editsToSend: Edit[] = [];
    for (const h of localInRange) {
      if (!remoteSet.has(hexHash(h))) {
        // Remote doesn't have this edit — include
        // it. For now, payload = hash (transport
        // layer resolves actual edit content).
        editsToSend.push({
          payload: h,
          signature: new Uint8Array(),
        });
      }
    }

    return {
      type: MessageType.EDIT_BATCH,
      channel,
      edits: editsToSend,
    };
  }

  function drainQueue(): Message | null {
    if (queryQueue.length === 0) return null;
    const next = queryQueue.shift()!;
    const root = ensureTrie();
    const local = queryPrefix(root, next.prefix, next.depth);

    // Don't skip empty local subtrees — the remote
    // may have edits there that we need to receive.
    return {
      type: MessageType.TRIE_QUERY,
      channel,
      prefix: next.prefix,
      depth: next.depth,
      fingerprint: local.fingerprint,
      editCount: local.editCount,
    };
  }

  return {
    sessionId,
    initiate,
    receive,
  };
}
