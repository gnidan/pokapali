// @pokapali/protocol — protocol-layer primitives.
//
// Hosts implementations that compose @pokapali/core
// interfaces with concrete transport / storage behavior.
// Strict layering: protocol imports from core; core
// never imports from protocol.

export { createLruCache } from "./lru-cache.js";
export type { LruCache, LruCacheOptions } from "./lru-cache.js";

export { createDocBlockResolver } from "./doc-block-resolver.js";
export type {
  DocBlockResolver,
  DocBlockResolverOptions,
  BlockPair,
} from "./doc-block-resolver.js";
