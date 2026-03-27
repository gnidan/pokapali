/**
 * @pokapali/comments — anchored, attributed, threaded
 * comments for pokapali documents.
 *
 * Generic over T (app-defined comment data).
 * Does NOT depend on @pokapali/core.
 */

import * as Y from "yjs";
import { createLogger } from "@pokapali/log";
import {
  anchorFromRelativePositions,
  createAnchor as createAnchorImpl,
  createPayloadResolver,
  resolveAnchor,
  resolveAnchorFromPayload,
  deriveTypeAccessor,
} from "./anchor.js";
import type { Anchor, ResolvedAnchor, ContentTypeAccessor } from "./anchor.js";
import type { Feed } from "./feed.js";
import { createFeed } from "./feed.js";
import {
  commentsMap,
  readComment,
  writeComment,
  updateCommentData,
  deleteComment,
} from "./storage.js";
import { verifyAuthor } from "./verify.js";
import type { ClientIdMapping, ClientIdentityInfo } from "./verify.js";

export {
  anchorFromRelativePositions,
  createPayloadResolver,
  resolveAnchorFromPayload,
  deriveTypeAccessor,
};
export type {
  Anchor,
  ResolvedAnchor,
  ContentTypeAccessor,
  Feed,
  ClientIdMapping,
  ClientIdentityInfo,
};

const log = createLogger("comments");

// ── Public types ──────────────────────────────────

export interface Comment<T> {
  id: string;
  author: string;
  authorVerified: boolean;
  content: string;
  ts: number;
  anchor: ResolvedAnchor | null;
  parentId: string | null;
  children: Comment<T>[];
  data: T;
}

export interface Comments<T> {
  /** Reactive comment list (top-level, threaded). */
  feed: Feed<Comment<T>[]>;

  /** Create an anchor from raw Yjs type indices. */
  createAnchor(start: number, end: number): Anchor;

  /** Add a comment or reply. Returns comment ID. */
  add(params: {
    content: string;
    anchor?: Anchor;
    parentId?: string;
    data: T;
  }): string;

  /** Update app-defined fields on a comment. */
  update(id: string, params: { data: Partial<T> }): void;

  /** Hard-delete a comment (removes Y.Map entry). */
  delete(id: string): void;

  /** Clean up observers. */
  destroy(): void;
}

export interface CommentsOptions {
  /** This device's identity pubkey (hex). */
  author: string | null;
  /**
   * Reactive clientID→identity mapping for author
   * verification. Pass doc.clientIdMapping from core.
   */
  clientIdMapping: Feed<ClientIdMapping>;
  /**
   * The Yjs shared type that holds the document
   * content. Anchors are resolved against this type.
   * Defaults to contentDoc.getText("default").
   * Pass contentDoc.getXmlFragment("default") for
   * Tiptap/ProseMirror.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentType?: Y.AbstractType<any>;
  /**
   * When provided, anchor resolution uses this
   * merged CRDT payload (from State view) instead
   * of the live contentDoc. A single temporary
   * Y.Doc is created per rebuild (not per anchor).
   *
   * Anchor creation still uses the live contentType.
   * This bridges the gap between the monoidal view
   * system and Yjs RelativePosition resolution.
   */
  contentPayload?: Feed<Uint8Array | null>;
}

// ── Factory ───────────────────────────────────────

export function comments<T>(
  commentsDoc: Y.Doc,
  contentDoc: Y.Doc,
  options: CommentsOptions,
): Comments<T> {
  const map = commentsMap(commentsDoc);
  const explicitContentType = options.contentType !== undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let contentType: Y.AbstractType<any>;
  if (explicitContentType) {
    contentType = options.contentType!;
  } else {
    // Check if "default" is already registered as a
    // specific non-Text type (e.g. XmlFragment from
    // Tiptap). Synced docs may have untyped entries
    // (constructor === AbstractType) which getText()
    // will upgrade — only reject known conflicts.
    const existing = contentDoc.share.get("default");
    if (
      existing &&
      existing.constructor !== Y.AbstractType &&
      !(existing instanceof Y.Text)
    ) {
      throw new Error(
        "No contentType provided and the content doc" +
          ' already has "default" registered as ' +
          existing.constructor.name +
          ", not Y.Text. Pass the correct shared" +
          " type as contentType (e.g.," +
          ' contentDoc.getXmlFragment("default")' +
          " for Tiptap/ProseMirror).",
      );
    }
    contentType = contentDoc.getText("default");
    log.warn(
      "No contentType provided — defaulting to" +
        ' getText("default"). Pass contentType' +
        " explicitly (e.g.," +
        ' contentDoc.getXmlFragment("default")' +
        " for Tiptap/ProseMirror).",
    );
  }
  // Bridge mode: resolve anchors from merged CRDT
  // payload instead of live Y.Doc.
  const bridgeAccessor: ContentTypeAccessor | null = options.contentPayload
    ? deriveTypeAccessor(contentDoc, contentType)
    : null;
  let latestPayload: Uint8Array | null =
    options.contentPayload?.getSnapshot() ?? null;

  const feed = createFeed<Comment<T>[]>(
    [],
    () => false, // always notify — we rebuild arrays
  );

  function project(): Comment<T>[] {
    const topLevel: Comment<T>[] = [];
    const childrenOf = new Map<string, Comment<T>[]>();

    // Bridge mode: create one temp doc per rebuild
    // instead of one per anchor.
    const resolver =
      bridgeAccessor && latestPayload
        ? createPayloadResolver(latestPayload, bridgeAccessor)
        : null;

    // First pass: build all Comment objects.
    const all = new Map<string, Comment<T>>();
    map.forEach((entry, id) => {
      const stored = readComment<T>(entry);
      const anchor =
        stored.anchorStart && stored.anchorEnd
          ? resolver
            ? resolver.resolve(stored.anchorStart, stored.anchorEnd)
            : resolveAnchor(
                contentDoc,
                contentType,
                stored.anchorStart,
                stored.anchorEnd,
              )
          : null;
      const comment: Comment<T> = {
        id,
        author: stored.author,
        authorVerified: verifyAuthor(
          entry,
          stored.author,
          options.clientIdMapping.getSnapshot(),
        ),
        content: stored.content,
        ts: stored.ts,
        anchor,
        parentId: stored.parentId,
        children: [],
        data: stored.data,
      };
      all.set(id, comment);
    });

    // Second pass: thread children under parents.
    for (const comment of all.values()) {
      if (comment.parentId) {
        let siblings = childrenOf.get(comment.parentId);
        if (!siblings) {
          siblings = [];
          childrenOf.set(comment.parentId, siblings);
        }
        siblings.push(comment);
      } else {
        topLevel.push(comment);
      }
    }

    // Attach children and sort by timestamp.
    for (const comment of all.values()) {
      const kids = childrenOf.get(comment.id);
      if (kids) {
        kids.sort((a, b) => a.ts - b.ts);
        comment.children = kids;
      }
    }
    topLevel.sort((a, b) => a.ts - b.ts);

    resolver?.destroy();
    return topLevel;
  }

  function rebuild() {
    feed._update(project());
  }

  // Observe changes to the comments Y.Map.
  const onMapChange = () => {
    rebuild();
  };
  map.observeDeep(onMapChange);

  // Observe content for anchor re-resolution.
  // Bridge mode subscribes to the payload feed;
  // direct mode observes the live content type.
  const onContentChange = () => {
    rebuild();
  };
  let unsubPayload: (() => void) | null = null;
  if (options.contentPayload) {
    unsubPayload = options.contentPayload.subscribe(() => {
      latestPayload = options.contentPayload!.getSnapshot();
      rebuild();
    });
  } else {
    contentType.observeDeep(onContentChange);
  }

  // Observe clientIdMapping for re-verification.
  const unsubMapping = options.clientIdMapping.subscribe(rebuild);

  // Initial projection.
  rebuild();

  let destroyed = false;
  function assertAlive() {
    if (destroyed) {
      throw new Error("Comments instance destroyed");
    }
  }

  return {
    feed,

    createAnchor(start: number, end: number): Anchor {
      assertAlive();
      return createAnchorImpl(contentType, start, end);
    },

    add(params): string {
      assertAlive();
      if (!options.author) {
        throw new Error("Cannot add comment: no author identity");
      }

      const id = crypto.randomUUID();

      // Validate parentId if provided.
      if (params.parentId !== undefined) {
        const parent = map.get(params.parentId);
        if (!parent) {
          throw new Error(`Parent comment "${params.parentId}" ` + "not found");
        }
        // One-level threading: can't reply to a reply.
        const parentParentId = parent.get("parentId") as string | null;
        if (parentParentId !== null) {
          throw new Error(
            "Cannot reply to a reply — " + "one-level threading only",
          );
        }
        // Replies must not have anchors.
        if (params.anchor) {
          throw new Error(
            "Replies inherit parent anchor — " +
              "do not pass anchor with parentId",
          );
        }
      }

      writeComment(
        map,
        id,
        options.author,
        params.content,
        params.anchor,
        params.parentId,
        params.data,
      );

      log.debug("added comment", id);
      return id;
    },

    update(id, params): void {
      assertAlive();
      updateCommentData<T>(map, id, params.data);
      log.debug("updated comment", id);
    },

    delete(id): void {
      assertAlive();
      deleteComment(map, id);
      log.debug("deleted comment", id);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      map.unobserveDeep(onMapChange);
      if (unsubPayload) {
        unsubPayload();
      } else {
        contentType.unobserveDeep(onContentChange);
      }
      unsubMapping();
      log.debug("destroyed comments instance");
    },
  };
}
