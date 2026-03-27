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
 */
export function inspect<V>(view: View<V>, document: Document): V {
  const results: Record<string, unknown> = {};

  for (const [channelName, measured] of Object.entries(view.channels)) {
    const ch = document.channel(channelName);
    const cache = Cache.create();
    results[channelName] = foldTree(measured, ch.tree, cache);
  }

  return view.combine(results);
}

/**
 * Evaluate a View against a Document up to a specific
 * epoch index (prefix evaluation).
 *
 * Folds each channel tree using `foldTree` with the
 * `{ at }` option, which splits the tree at the given
 * epoch count and folds only the left prefix.
 *
 * @param view       The monoidal view to evaluate
 * @param document   The document to evaluate against
 * @param epochIndex Number of epochs to include
 * @returns The folded monoidal value
 */
export function evaluateAt<V>(
  view: View<V>,
  document: Document,
  epochIndex: number,
): V {
  const results: Record<string, unknown> = {};

  for (const [channelName, measured] of Object.entries(view.channels)) {
    const ch = document.channel(channelName);
    const cache = Cache.create();
    results[channelName] = foldTree(measured, ch.tree, cache, {
      at: epochIndex,
    });
  }

  return view.combine(results);
}
