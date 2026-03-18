# @pokapali/react

```sh
npm install @pokapali/react
```

React hooks for pokapali documents. Thin wrappers
around `@pokapali/core` APIs that handle
subscriptions, cleanup, and re-rendering.

## Quick Start

```typescript
import { pokapali } from "@pokapali/core";
import {
  useFeed,
  useDocReady,
  useAutoSave,
  useDocDestroy,
} from "@pokapali/react";

function Editor({ doc }: { doc: Doc }) {
  const ready = useDocReady(doc);
  const status = useFeed(doc.status);
  const saveState = useFeed(doc.saveState);

  useAutoSave(doc);
  useDocDestroy(doc); // must be last hook

  if (!ready) return <p>Loading...</p>;

  return (
    <div>
      <p>Status: {status}</p>
      <p>Save: {saveState}</p>
      {/* wire doc.channel("content") to your editor */}
    </div>
  );
}
```

## Hooks

### Stable

| Hook            | Signature                      | Description                                                                                                                         |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `useFeed`       | `(feed: Feed<T>) => T`         | Subscribe to a reactive Feed via `useSyncExternalStore`. Accepts `null`/`undefined`, returns `undefined` until a feed is available. |
| `useDocReady`   | `(doc, timeoutMs?) => boolean` | Returns `true` once `doc.ready()` resolves. Optional timeout resolves early.                                                        |
| `useDocDestroy` | `(doc) => void`                | Calls `doc.destroy()` on unmount. Declare this hook **last** so React cleans it up first (reverse order).                           |

### Experimental

| Hook               | Signature                                       | Description                                                                                            |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `useAutoSave`      | `(doc, debounceMs?) => void`                    | Sets up debounced auto-publish. No-op if the doc lacks push capability. Cleans up on unmount.          |
| `useParticipants`  | `(doc) => ReadonlyMap<number, ParticipantInfo>` | Subscribe to awareness and return the current participant map. Re-renders on awareness changes.        |
| `useSnapshotFlash` | `(doc, durationMs?) => boolean`                 | Returns `true` briefly after a snapshot event, for visual feedback (flash/pulse). Defaults to 2000 ms. |

## Peer Dependencies

- `@pokapali/core`
- `react` >= 18

## Links

- [Root README](../../README.md)
