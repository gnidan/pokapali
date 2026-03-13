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

## Key Exports

- **`CapabilityKeys`** — interface for the optional key
  set (readKey, ipnsKeyBytes, rotationKey, namespaceKeys,
  awarenessRoomPassword)
- **`Capability`** — inferred access level (namespaces,
  canPushSnapshots, isAdmin)
- **`inferCapability(keys)`** — determines access level
  from which keys are present
- **`buildUrl(base, ipnsName, keys)`** — encodes keys
  into a capability URL
- **`parseUrl(url)`** — decodes a capability URL into
  base, ipnsName, and keys
- **`narrowCapability(keys, grant)`** — produces a
  subset of keys for a lower-privilege URL
- **`CapabilityGrant`** — specifies which namespaces
  and whether `canPushSnapshots` to include

## Links

- [Root README](../../README.md)
- [Architecture — Capability URLs](../../docs/architecture.md)
