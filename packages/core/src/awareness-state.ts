/**
 * awareness-state.ts — Typed accessors for custom
 * awareness state fields.
 *
 * y-protocols Awareness.getStates() returns
 * Map<number, { [x: string]: any }>. This module
 * provides type-safe access to the custom fields
 * set via setLocalStateField() throughout the
 * codebase, replacing unsafe `(state as any).field`
 * patterns.
 */

import type { AwarenessTopology } from "./topology-sharing.js";

/**
 * Custom fields stored in each peer's awareness
 * state via setLocalStateField().
 */
export interface AwarenessFields {
  relays?: string[];
  clockSum?: number;
  topology?: AwarenessTopology;
  participant?: {
    name?: string;
    color?: string;
    identityPubKey?: string;
    signature?: string;
  };
  user?: {
    name?: string;
    color?: string;
  };
}

/** Type-safe field access on an awareness state
 *  entry. Avoids `(state as any).field` casts. */
export function awarenessField<K extends keyof AwarenessFields>(
  state: { [x: string]: unknown } | null | undefined,
  key: K,
): AwarenessFields[K] | undefined {
  if (!state) return undefined;
  return state[key] as AwarenessFields[K] | undefined;
}
