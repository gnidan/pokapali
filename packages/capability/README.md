# @pokapali/capability

```sh
npm install @pokapali/capability
```

Capability URL encoding, decoding, and access level
inference. A capability URL's fragment contains a
version-prefixed, labeled key set — which keys are present
determines the access level (admin, writer, read-only).
This package handles serialization and provides
`narrowCapability` for generating lower-privilege URLs.

## Usage

```typescript
import {
  buildUrl,
  parseUrl,
  inferCapability,
  narrowCapability,
} from "@pokapali/capability";

// Build a capability URL from keys
const url = await buildUrl("https://my-app.com", ipnsName, keys);
// → "https://my-app.com/doc/<ipnsName>#<encoded-keys>"

// Parse a capability URL back into its parts
const { base, ipnsName, keys } = await parseUrl(url);

// Determine what this key set can do
const cap = inferCapability(keys, ["content", "comments"]);
console.log(cap.isAdmin); // true if rotationKey present
console.log(cap.canPushSnapshots); // true if ipnsKeyBytes present
console.log(cap.channels); // Set of writable channel names

// Generate a lower-privilege URL for sharing
const writeKeys = narrowCapability(keys, {
  channels: ["content"],
  canPushSnapshots: true,
});
const writeUrl = await buildUrl(base, ipnsName, writeKeys);
// writeUrl grants content-channel write access only
```

## Key Exports

- **`CapabilityKeys`** — interface for the optional key
  set (readKey, ipnsKeyBytes, rotationKey, channelKeys,
  awarenessRoomPassword)
- **`Capability`** — inferred access level (channels,
  canPushSnapshots, isAdmin)
- **`inferCapability(keys)`** — determines access level
  from which keys are present
- **`buildUrl(base, ipnsName, keys)`** — encodes keys
  into a capability URL
- **`parseUrl(url)`** — decodes a capability URL into
  base, ipnsName, and keys
- **`narrowCapability(keys, grant)`** — produces a
  subset of keys for a lower-privilege URL
- **`CapabilityGrant`** — specifies which channels
  and whether `canPushSnapshots` to include

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
- [Architecture — Capability URLs](https://github.com/gnidan/pokapali/tree/main/docs/internals)
