/**
 * Author verification via clientID→pubkey mapping.
 *
 * Each session registers { [clientID]: { pubkey, sig } }
 * in _meta. We look up a Y.Map item's creator clientID
 * in the mapping to verify the author field matches.
 */

import * as Y from "yjs";

/**
 * Per-clientID identity info. Mirrors core's
 * ClientIdentityInfo without importing it.
 */
export interface ClientIdentityInfo {
  pubkey: string;
  verified: boolean;
}

/**
 * Mapping from Yjs clientID → identity info.
 * Provided by core's doc.clientIdMapping.getSnapshot().
 */
export type ClientIdMapping = ReadonlyMap<number, ClientIdentityInfo>;

/**
 * Verify that a comment's author field matches the
 * clientID→pubkey mapping for the Y.Map item that
 * created it.
 *
 * Returns true if:
 *   1. The Y.Map item has a known creator clientID
 *   2. The mapping contains that clientID
 *   3. The entry's sig is verified
 *   4. The mapped pubkey matches the author field
 *
 * Returns false if any step fails.
 */
export function verifyAuthor(
  entry: Y.Map<unknown>,
  author: string,
  mapping: ClientIdMapping,
): boolean {
  // Y.Map's internal item tracks the clientID of
  // whoever created it. Access via _item.id.client.
  const item = (entry as unknown as { _item?: Y.Item })._item;
  if (!item) return false;

  const clientId = item.id.client;
  const info = mapping.get(clientId);
  if (!info) return false;
  if (!info.verified) return false;

  return info.pubkey === author;
}
