/**
 * Document — per-document container.
 *
 * Holds per-channel epoch trees, identity, and
 * capability. Channels are lazy get-or-create.
 * Destroy cascades to all channels.
 *
 * Lifecycle levels control which monoidal views
 * are active on each channel:
 *   background — tree + Summary only (near-zero)
 *   active     — + merged-payload (State view)
 *   syncing    — + content-hash (Fingerprint view)
 *   inspecting — + diff capability
 */
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { Codec } from "@pokapali/codec";
import type { Capability } from "../capability/capability.js";
import type { Channel } from "../channel/channel.js";
import { Channel as ChannelCompanion } from "../channel/channel.js";
import * as State from "../state/index.js";
import * as Fingerprint from "../fingerprint/index.js";

/**
 * @deprecated Use {@link Ed25519KeyPair} from
 *   `@pokapali/crypto` instead.
 */
export type DocumentIdentity = Ed25519KeyPair;

/**
 * @deprecated Use {@link Capability} from
 *   `@pokapali/document` instead.
 */
export type DocumentCapability = Capability;

/** Lifecycle levels — ordered by cost. */
export type Level = "background" | "active" | "syncing" | "inspecting";

const LEVEL_ORDER: readonly Level[] = [
  "background",
  "active",
  "syncing",
  "inspecting",
];

function levelIndex(level: Level): number {
  return LEVEL_ORDER.indexOf(level);
}

/**
 * Per-document container holding channels, identity,
 * capability, and lifecycle state.
 */
export interface Document {
  channel(name: string): Channel;
  readonly identity: Ed25519KeyPair;
  readonly capability: Capability;
  /** Current lifecycle level. */
  readonly level: Level;
  /** Activate views up to (and including) the given
   *  level on all channels. Levels above background
   *  require a codec. */
  activate(level: Level): void;
  /** Deactivate all views, returning to background. */
  deactivate(): void;
  destroy(): void;
}

/**
 * Companion object for the Document type.
 */
export const Document = {
  /**
   * Create a Document with identity and capability.
   * Channels are created lazily on first access.
   * Pass a codec to enable lifecycle levels above
   * background.
   */
  create(opts: {
    identity: Ed25519KeyPair;
    capability: Capability;
    codec?: Codec;
  }): Document {
    const channels = new Map<string, Channel>();
    let currentLevel: Level = "background";

    /** Activate views for the given level on a
     *  single channel. */
    function activateChannel(ch: Channel, level: Level): void {
      const idx = levelIndex(level);
      if (idx >= levelIndex("active")) {
        ch.activate(State.view(opts.codec!));
      }
      if (idx >= levelIndex("syncing")) {
        ch.activate(Fingerprint.view());
      }
      // inspecting: level flag only — diff is
      // computed on demand, not as a monoidal view
    }

    /** Deactivate views that belong to levels above
     *  the target level on a single channel. */
    function deactivateChannel(ch: Channel, targetLevel: Level): void {
      const idx = levelIndex(targetLevel);
      if (idx < levelIndex("syncing")) {
        ch.deactivate("content-hash");
      }
      if (idx < levelIndex("active")) {
        ch.deactivate("merged-payload");
      }
    }

    return {
      channel(name: string): Channel {
        let ch = channels.get(name);
        if (!ch) {
          ch = ChannelCompanion.create(name);
          channels.set(name, ch);
          if (currentLevel !== "background") {
            activateChannel(ch, currentLevel);
          }
        }
        return ch;
      },

      get identity() {
        return opts.identity;
      },

      get capability() {
        return opts.capability;
      },

      get level() {
        return currentLevel;
      },

      activate(level: Level): void {
        if (level === "background") {
          return;
        }
        if (!opts.codec) {
          throw new Error(
            "A codec is required for lifecycle " +
              "levels above background. Pass a " +
              "codec to Document.create().",
          );
        }

        const oldIdx = levelIndex(currentLevel);
        const newIdx = levelIndex(level);
        currentLevel = level;

        if (newIdx > oldIdx) {
          // Stepping up — activate new views
          for (const ch of channels.values()) {
            activateChannel(ch, level);
          }
        } else if (newIdx < oldIdx) {
          // Stepping down — deactivate higher views
          for (const ch of channels.values()) {
            deactivateChannel(ch, level);
          }
        }
      },

      deactivate(): void {
        currentLevel = "background";
        for (const ch of channels.values()) {
          deactivateChannel(ch, "background");
        }
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
