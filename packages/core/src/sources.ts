/**
 * sources.ts — Re-export barrel for backward
 * compatibility.
 *
 * Split into:
 *   feed.ts        — Feed<T>, WritableFeed<T>, createFeed
 *   async-utils.ts — AsyncQueue, createAsyncQueue, merge, scan
 *   fact-sources.ts — reannounceFacts, ipnsFacts, eventFacts
 */

export type { Feed, WritableFeed } from "./feed.js";
export { createFeed } from "./feed.js";

export type { AsyncQueue } from "./async-utils.js";
export { createAsyncQueue, merge, scan } from "./async-utils.js";

export { reannounceFacts, ipnsFacts, eventFacts } from "./fact-sources.js";
