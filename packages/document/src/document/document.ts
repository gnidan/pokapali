/**
 * Document — per-document container.
 *
 * Holds per-channel epoch trees, identity, and
 * capability. Channels are lazy get-or-create.
 * Destroy cascades to all channels.
 *
 * View activation is document-level: activate(view)
 * registers a monoidal view, delegates per-channel
 * evaluation to each channel, and combines results
 * into a single reactive feed.
 */
import type { Ed25519KeyPair } from "@pokapali/crypto";
import type { Codec } from "@pokapali/codec";
import type { Capability } from "../capability/capability.js";
import type { Channel } from "../channel/channel.js";
import { Channel as ChannelCompanion } from "../channel/channel.js";
import type { View } from "../view.js";
import type { Feed } from "../feed/feed.js";
import type { Status } from "../view.js";
import { Status as StatusCompanion } from "../view.js";
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

/**
 * @deprecated Use Document.activate(view) instead.
 *   Will be removed in a future release.
 */
export type Level = "background" | "active" | "syncing" | "inspecting";

/**
 * Per-document container holding channels, identity,
 * capability, and active views.
 */
export interface Document {
  channel(name: string): Channel;
  readonly identity: Ed25519KeyPair;
  readonly capability: Capability;
  /**
   * @deprecated Use activate(view) / deactivate()
   *   instead. Returns the highest active level.
   */
  readonly level: Level;
  /**
   * Activate a view at the document level.
   *
   * Delegates per-channel evaluation to each channel
   * named in `view.channels`, then combines results
   * via `view.combine`. Returns a reactive feed.
   *
   * Idempotent: re-activating the same view name
   * returns the existing feed.
   */
  activate<V>(view: View<V>): Pick<Feed<V>, "getSnapshot" | "subscribe">;
  /**
   * @deprecated Use activate(view: View<V>) instead.
   */
  activate(level: Level): void;
  /**
   * Deactivate a view by name.
   *
   * Removes per-channel feeds and the combined feed.
   */
  deactivate(viewName: string): void;
  /**
   * @deprecated Use deactivate(viewName) instead.
   *   Deactivates ALL views, returning to background.
   */
  deactivate(): void;
  destroy(): void;
}

/** Internal state for an active document-level view. */
interface ActiveView<V> {
  readonly view: View<V>;
  /** Per-channel feed subscriptions. */
  readonly unsubs: (() => void)[];
  /** Per-channel feed getters. */
  readonly channelFeeds: Map<
    string,
    Pick<Feed<unknown>, "getSnapshot" | "subscribe">
  >;
  /** Combined feed state + subscribers. */
  status: Status<V>;
  readonly subs: Set<() => void>;
}

/**
 * Companion object for the Document type.
 */
export const Document = {
  /**
   * Create a Document with identity and capability.
   * Channels are created lazily on first access.
   * Pass a codec to enable the deprecated level-based
   * activate(level) API.
   */
  create(opts: {
    identity: Ed25519KeyPair;
    capability: Capability;
    codec?: Codec;
  }): Document {
    const channels = new Map<string, Channel>();
    let deprecatedLevel: Level = "background";

    const activeViews = new Map<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ActiveView<any>
    >();

    function getOrCreateChannel(name: string): Channel {
      let ch = channels.get(name);
      if (!ch) {
        ch = ChannelCompanion.create(name);
        channels.set(name, ch);
        // Activate any existing views that include
        // this channel
        for (const av of activeViews.values()) {
          if (name in av.view.channels) {
            activateChannelForView(ch, av);
          }
        }
      }
      return ch;
    }

    /** Activate a single channel for an active view
     *  and subscribe to its feed updates. */
    function activateChannelForView<V>(ch: Channel, av: ActiveView<V>): void {
      if (av.channelFeeds.has(ch.name)) return;

      const feed = ch.activate(av.view);
      av.channelFeeds.set(ch.name, feed);

      const unsub = feed.subscribe(() => {
        recompute(av);
      });
      av.unsubs.push(unsub);
    }

    /** Re-combine per-channel results and notify
     *  document-level subscribers. */
    function recompute<V>(av: ActiveView<V>): void {
      const results: Record<string, unknown> = {};
      let allReady = true;

      for (const [name, feed] of av.channelFeeds) {
        const snap = feed.getSnapshot();
        if (snap.tag === "ready") {
          results[name] = snap.value;
        } else if (snap.tag === "stale") {
          results[name] = snap.lastValue;
          allReady = false;
        } else {
          allReady = false;
        }
      }

      if (allReady) {
        const combined = av.view.combine(results);
        av.status = StatusCompanion.ready(combined);
      } else {
        const prev = av.status;
        if (prev.tag === "ready") {
          av.status = StatusCompanion.stale(prev.value);
        }
        // stale stays stale, pending stays pending
      }

      for (const cb of av.subs) cb();
    }

    function activateView<V>(
      view: View<V>,
    ): Pick<Feed<V>, "getSnapshot" | "subscribe"> {
      const existing = activeViews.get(view.name);
      if (existing) {
        return {
          getSnapshot: () => existing.status as Status<V>,
          subscribe: (cb) => {
            existing.subs.add(cb);
            return () => existing.subs.delete(cb);
          },
        };
      }

      const av: ActiveView<V> = {
        view,
        unsubs: [],
        channelFeeds: new Map(),
        status: StatusCompanion.pending(),
        subs: new Set(),
      };

      activeViews.set(view.name, av);

      // Activate on all existing channels that this
      // view references
      for (const channelName of Object.keys(view.channels)) {
        const ch = getOrCreateChannel(channelName);
        activateChannelForView(ch, av);
      }

      // Compute initial combined value
      recompute(av);

      return {
        getSnapshot: () => av.status,
        subscribe: (cb) => {
          av.subs.add(cb);
          return () => av.subs.delete(cb);
        },
      };
    }

    function deactivateView(viewName: string): void {
      const av = activeViews.get(viewName);
      if (!av) return;

      for (const unsub of av.unsubs) unsub();
      for (const ch of channels.values()) {
        ch.deactivate(viewName);
      }

      av.subs.clear();
      activeViews.delete(viewName);
    }

    const doc: Document = {
      channel: getOrCreateChannel,

      get identity() {
        return opts.identity;
      },

      get capability() {
        return opts.capability;
      },

      get level(): Level {
        return deprecatedLevel;
      },

      activate(
        viewOrLevel: View<unknown> | Level,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): any {
        if (typeof viewOrLevel === "string") {
          // Deprecated level-based activation
          if (viewOrLevel === "background") return;
          if (!opts.codec) {
            throw new Error(
              "A codec is required for " +
                "level-based activation. " +
                "Pass a codec to " +
                "Document.create().",
            );
          }
          deprecatedLevel = viewOrLevel;
          if (
            viewOrLevel === "active" ||
            viewOrLevel === "syncing" ||
            viewOrLevel === "inspecting"
          ) {
            activateView(State.view(opts.codec));
          } else {
            deactivateView("merged-payload");
          }
          if (viewOrLevel === "syncing" || viewOrLevel === "inspecting") {
            activateView(Fingerprint.view());
          } else {
            deactivateView("content-hash");
          }
          return;
        }

        return activateView(viewOrLevel);
      },

      deactivate(viewName?: string): void {
        if (viewName === undefined) {
          // Deprecated: deactivate all
          for (const name of [...activeViews.keys()]) {
            deactivateView(name);
          }
          deprecatedLevel = "background";
          return;
        }
        deactivateView(viewName);
      },

      destroy() {
        for (const name of [...activeViews.keys()]) {
          deactivateView(name);
        }
        for (const ch of channels.values()) {
          ch.destroy();
        }
        channels.clear();
      },
    };

    return doc;
  },
};
