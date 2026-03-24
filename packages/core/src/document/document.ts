/**
 * Document — per-document container.
 *
 * Holds per-channel epoch trees, identity, and
 * capability. Channels are lazy get-or-create.
 * Destroy cascades to all channels.
 */
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { Capability } from "@pokapali/capability";
import type { Channel } from "../channel/channel.js";
import { createChannel } from "../channel/channel.js";

/**
 * Per-document container holding channels, identity,
 * and capability.
 */
export interface Document {
  channel(name: string): Channel;
  readonly identity: Ed25519KeyPair;
  readonly capability: Capability;
  destroy(): void;
}

/**
 * Create a Document with identity and capability.
 * Channels are created lazily on first access.
 */
export function createDocument(opts: {
  identity: Ed25519KeyPair;
  capability: Capability;
}): Document {
  const channels = new Map<string, Channel>();

  return {
    channel(name: string): Channel {
      let ch = channels.get(name);
      if (!ch) {
        ch = createChannel(name);
        channels.set(name, ch);
      }
      return ch;
    },

    get identity() {
      return opts.identity;
    },

    get capability() {
      return opts.capability;
    },

    destroy() {
      for (const ch of channels.values()) {
        ch.destroy();
      }
      channels.clear();
    },
  };
}
