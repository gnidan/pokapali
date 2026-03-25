/**
 * Document — per-document container.
 *
 * Holds per-channel epoch trees, identity, and
 * capability. Channels are lazy get-or-create.
 * Destroy cascades to all channels.
 */
import type { Channel } from "../channel/channel.js";
import { Channel as ChannelCompanion } from "../channel/channel.js";

/**
 * Identity keypair for document authorship.
 */
export interface DocumentIdentity {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * Access capability for a document.
 */
export interface DocumentCapability {
  readonly channels: Set<string>;
  readonly canPushSnapshots: boolean;
  readonly isAdmin: boolean;
}

/**
 * Per-document container holding channels, identity,
 * and capability.
 */
export interface Document {
  channel(name: string): Channel;
  readonly identity: DocumentIdentity;
  readonly capability: DocumentCapability;
  destroy(): void;
}

/**
 * Companion object for the Document type.
 */
export const Document = {
  /**
   * Create a Document with identity and capability.
   * Channels are created lazily on first access.
   */
  create(opts: {
    identity: DocumentIdentity;
    capability: DocumentCapability;
  }): Document {
    const channels = new Map<string, Channel>();

    return {
      channel(name: string): Channel {
        let ch = channels.get(name);
        if (!ch) {
          ch = ChannelCompanion.create(name);
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
  },
};
