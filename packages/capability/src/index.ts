import type { DocKeys } from "@pokapali/crypto";

export interface CapabilityKeys {
  readKey?: CryptoKey;
  ipnsKeyBytes?: Uint8Array;
  rotationKey?: Uint8Array;
  awarenessRoomPassword?: string;
  namespaceKeys?: Record<string, Uint8Array>;
}

export interface Capability {
  namespaces: Set<string>;
  canPushSnapshots: boolean;
  isAdmin: boolean;
}

export function encodeFragment(
  keys: CapabilityKeys
): string {
  throw new Error("not implemented");
}

export function decodeFragment(
  fragment: string
): CapabilityKeys {
  throw new Error("not implemented");
}

export function inferCapability(
  keys: CapabilityKeys,
  namespaces: string[]
): Capability {
  throw new Error("not implemented");
}

export interface ParsedUrl {
  base: string;
  ipnsName: string;
  keys: CapabilityKeys;
}

export function buildUrl(
  base: string,
  ipnsName: string,
  keys: CapabilityKeys
): string {
  throw new Error("not implemented");
}

export function parseUrl(
  url: string
): ParsedUrl {
  throw new Error("not implemented");
}

export interface CapabilityGrant {
  namespaces?: string[];
  canPushSnapshots?: boolean;
}

export function narrowCapability(
  keys: CapabilityKeys,
  grant: CapabilityGrant
): CapabilityKeys {
  throw new Error("not implemented");
}

// Re-export DocKeys for convenience
export type { DocKeys };
