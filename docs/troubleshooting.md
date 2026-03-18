# Troubleshooting

Common issues and how to resolve them. If your
problem isn't listed here, check the
[guide](guide.md) for detailed API explanations or
file an issue on GitHub.

---

## Connection and sync

### Document stays in "connecting" forever

Pokapali uses WebRTC for peer-to-peer sync. Common
causes of connection failure:

- **Firewall or corporate proxy** blocks WebRTC
  traffic. Try a different network — home WiFi or
  mobile hotspot usually works. Enterprise firewalls
  often block UDP and STUN/TURN traffic.
- **Browser WebRTC disabled.** Some privacy-hardened
  browsers or extensions disable WebRTC entirely.
  Check `about:config` (Firefox) or extension
  settings.
- **All relays unreachable.** Pokapali discovers peers
  through relay nodes. If none are reachable, the
  document can't find peers. Check your browser's
  network tab for failed WebSocket connections.

**Tip:** The first 5 seconds after opening a document
show `"connecting"` even if peers are available — this
is a grace period to allow the GossipSub mesh to form.
Wait at least 10 seconds before diagnosing a
connection problem.

### Status shows "receiving" but not "synced"

`"receiving"` means the document is subscribed to the
GossipSub topic but hasn't confirmed two-way sync. If
the document has read-only access (opened from a read
URL), `"receiving"` is the expected steady state — you
can receive updates but not send them.

If the document should have write access, check that
the URL contains the correct capability fragment.

### Changes aren't reaching other peers

Check `doc.saveState`:

```ts
doc.saveState.subscribe(() => {
  console.log(doc.saveState.getSnapshot());
});
```

- `"dirty"` — changes exist but haven't been published
  yet. Publishing happens automatically; wait a few
  seconds.
- `"saving"` — a publish is in progress.
- `"save-error"` — the last publish failed. Check
  `doc.lastPersistenceError` for related details.
- `"saved"` — the snapshot was published and
  acknowledged. If other peers still don't see it,
  they may have a connectivity issue on their end.

---

## IndexedDB and persistence

### "Local storage error" / quota exceeded

Pokapali stores document data in IndexedDB. In
incognito/private browsing, most browsers severely
limit IDB quota (sometimes as low as 5 MB).

Monitor persistence errors:

```ts
doc.lastPersistenceError.subscribe(() => {
  const err = doc.lastPersistenceError.getSnapshot();
  if (err) {
    console.warn("IDB write failed:", err);
  }
});
```

When IDB writes fail, **changes still sync to
connected peers** — they just won't survive a page
reload on this device. If you're in incognito mode,
this is expected behavior.

### Data missing after page reload

If local data isn't loading after reload:

1. Check that `persistence` isn't set to `false` in
   your config (it defaults to `true`).
2. Check the browser's DevTools → Application →
   IndexedDB for your app's databases. If empty,
   storage may have been cleared by the browser.
3. If `doc.lastPersistenceError` fired earlier in the
   session, IDB writes were failing and the data was
   only held in memory.

---

## Capability URLs and access

### "Fragment too short" error

```
Fragment too short — the URL fragment should contain
an encoded capability. Check that the URL was not
truncated
```

The URL was cut off during copy/paste. Capability
URLs encode access permissions in the URL hash
fragment. If the fragment is missing or truncated,
the document can't be opened. Copy the full URL
including the `#` and everything after it.

### "Unknown fragment version" error

```
Unknown fragment version: N — this URL may have been
created by a newer version of pokapali
```

The URL was created by a newer version of the
library than the one you're running. Update
`@pokapali/core` to the latest version.

### "Unknown channel" error

```
Unknown channel "comments". Configured: ["content"]
```

You're trying to access a channel that wasn't
declared in `channels` when calling `pokapali()`.
Channels are fixed at initialization — you can't add
them later.

```ts
// Wrong: "comments" not declared
const app = pokapali({
  channels: ["content"],
  // ...
});
doc.channel("comments"); // throws

// Right: declare all channels up front
const app = pokapali({
  channels: ["content", "comments"],
  // ...
});
```

### Write operations silently fail

If you have a read-only capability URL, write
operations won't throw — they apply locally but don't
propagate. Check the capability to see your access
level:

```ts
doc.capability.isAdmin; // full control?
doc.capability.canPushSnapshots; // can publish?
doc.capability.channels; // writable channels
```

Or use `doc.urls` to get shareable links at each
tier:

```ts
doc.urls.admin; // full control (null if not admin)
doc.urls.write; // edit + publish (null if read-only)
doc.urls.read; // view only (always available)
```

---

## Comments

### "No contentType provided" error

```
No contentType provided and the content doc already
has "default" registered as XmlFragment, not Y.Text.
```

This happens when the Yjs shared type doesn't match
what the comments system expects. If you're using
Tiptap or ProseMirror (which use `XmlFragment`),
pass the correct type:

```ts
import { comments } from "@pokapali/comments";

const c = comments(commentsDoc, contentDoc, {
  contentType: contentDoc.getXmlFragment("default"),
});
```

`comments()` takes two separate `Y.Doc` arguments:
one for comment storage and one for the content
being annotated.

### "Cannot add comment: no author identity"

The document hasn't finished identity setup.
Wait for `doc.ready()` before creating comments:

```ts
await doc.ready();
// Now safe to add comments
```

### Existing documents crash when adding comments

If a document was created without a `"comments"`
channel and you later add it to your `channels`
config, existing documents will lack the channel
data. Re-invite collaborators with updated capability
URLs that include the new channel.

---

## Loading and snapshots

### Loading stuck in "retrying"

```ts
doc.loading.subscribe(() => {
  const state = doc.loading.getSnapshot();
  if (state.status === "retrying") {
    console.log(`Retry ${state.attempt}, next at`, new Date(state.nextRetryAt));
  }
});
```

The document is trying to fetch a snapshot block that
isn't available yet. This can happen when:

- The pinner or relay that holds the block is
  temporarily down.
- The block was published very recently and hasn't
  propagated.
- Network connectivity is intermittent.

Retries use exponential backoff (10s, 30s, 90s) and
are also triggered by GossipSub re-announcements. If
retries exhaust (3 attempts), the loading state moves
to `"failed"` and the document becomes ready with
whatever local data is available.

### Snapshot validation warning

If `doc.lastValidationError` fires, a remote snapshot
failed validation (bad structure, invalid signature,
or missing publisher attestation). The invalid
snapshot is rejected — the document continues working
with valid data.

```ts
doc.lastValidationError.subscribe(() => {
  const err = doc.lastValidationError.getSnapshot();
  if (err) {
    console.warn(`Bad snapshot ${err.cid}:`, err.message);
  }
});
```

This is a safety mechanism, not an error you need to
fix. It means someone published a malformed snapshot
and your client correctly rejected it.

---

## TypeScript

### Build errors from transitive dependencies

If your `tsconfig.json` targets ES2022 or earlier,
a transitive dependency may cause type errors. Add
`"skipLibCheck": true` to `compilerOptions`:

```json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
```

---

## Configuration

### Two apps sharing the same `appId`

`appId` scopes relay discovery and GossipSub topic
names. If two different apps use the same `appId`,
they share relay traffic and pinner infrastructure.
This won't cause data leaks (documents are encrypted
with unique keys), but it increases unnecessary
network traffic.

Use a unique `appId` per application.

### Multiple PokapaliApp instances

Don't create multiple `pokapali()` instances. Each
one starts its own Helia node, libp2p stack, and
GossipSub mesh. Call `pokapali()` once at module
scope and reuse the returned `app` instance.

```ts
// Wrong: new instance per component render
function MyComponent() {
  const app = pokapali({ ... }); // Don't do this

// Right: module-level singleton
const app = pokapali({ ... });

function MyComponent() {
  // use app here
}
```

---

## Still stuck?

- Check the [guide](guide.md) for detailed API
  documentation on status, persistence, and feeds.
- Check the [integration guide](integration-guide.md)
  for framework-specific patterns.
- See [API stability tiers](api-stability.md) to
  understand which APIs are stable vs. experimental.
- [File an issue](https://github.com/gnidan/pokapali/issues)
  with your browser, OS, and the output of
  `doc.diagnostics()`.
