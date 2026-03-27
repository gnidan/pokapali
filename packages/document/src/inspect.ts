/**
 * inspect — one-shot document-level view evaluation.
 *
 * For each channel in the view, folds the channel's
 * history tree with the channel's Measured, then
 * combines per-channel results via `view.combine`.
 *
 * Creates temporary caches — for repeated evaluation,
 * use `Document.activate(view)` instead.
 */
import type { View } from "./view.js";
import { Cache, foldTree } from "./view.js";
import type { Document } from "./document/document.js";

/**
 * Evaluate a View against a Document's current state.
 *
 * One-shot: folds each channel tree, combines results.
 * No caching or subscriptions — use Document.activate
 * for reactive evaluation.
 *
 * With `{ upTo: n }`, folds only the first `n` epochs
 * (prefix evaluation) instead of the full tree.
 */
export function inspect<V>(
  view: View<V>,
  document: Document,
  opts?: { upTo: number },
): V {
  const results: Record<string, unknown> = {};
  const foldOpts = opts ? { at: opts.upTo } : undefined;

  for (const [channelName, measured] of Object.entries(view.channels)) {
    const ch = document.channel(channelName);
    const cache = Cache.create();
    results[channelName] = foldTree(measured, ch.tree, cache, foldOpts);
  }

  return view.combine(results);
}
