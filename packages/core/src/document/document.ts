/**
 * Re-export Document from @pokapali/document
 * for backwards compatibility.
 */
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { Capability } from "@pokapali/capability";
import type { Channel } from "../channel/channel.js";
import { createChannel } from "../channel/channel.js";

export interface Document {
  channel(name: string): Channel;
  readonly identity: Ed25519KeyPair;
  readonly capability: Capability;
  destroy(): void;
}

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
