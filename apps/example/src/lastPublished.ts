/**
 * Compute the next `lastPublished` timestamp from the
 * previous value and a newly-observed snapshot event
 * timestamp.
 *
 * Latest-publish-wins semantics: a snapshot event with
 * an older `eventTs` (e.g., a late joiner receiving
 * historical snapshots from a peer) MUST NOT move
 * `lastPublished` backward. If we used `Date.now()` or
 * raw `eventTs`, receiving a stream of older snapshots
 * would make the "last updated" display read "just now"
 * for content that's actually hours or days old.
 */
export function nextPublishedTs(prev: number, eventTs: number): number {
  return Math.max(prev, eventTs);
}
