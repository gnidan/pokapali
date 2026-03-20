# @pokapali/test-utils

```sh
npm install @pokapali/test-utils
```

Yjs-level sync harness for testing multi-peer
scenarios. Fully synchronous — no timers, no
flakiness.

## Quick Start

```typescript
import { createTestNetwork } from "@pokapali/test-utils";

const net = createTestNetwork({
  channels: ["content"],
});

const alice = net.peer("alice");
const bob = net.peer("bob");

// Edits propagate instantly.
alice.channel("content").getMap("d").set("key", "val");
bob.channel("content").getMap("d").get("key"); // "val"

// Simulate network partition.
net.disconnect("alice", "bob");
alice.channel("content").getMap("d").set("a", 1);
bob.channel("content").getMap("d").set("b", 2);

// Reconnect merges diverged state.
net.reconnect("alice", "bob");
alice.channel("content").getMap("d").get("b"); // 2
bob.channel("content").getMap("d").get("a"); // 1

net.destroy();
```

## Key Exports

- **`createTestNetwork(options)`** — factory returning
  a `TestNetwork` instance
- **`TestNetworkOptions`** — `channels: string[]`,
  `latency?: LatencyOptions`
- **`LatencyOptions`** — `ms: number`,
  `jitter?: number` (simulates network delay)
- **`TestNetwork`** — `peer()`, `disconnect()`,
  `reconnect()`, `partition()`, `heal()`,
  `isConverged()`, `settle()`, `destroy()`
- **`TestPeer`** — `name`, `channel(name)` (returns
  Y.Doc)
- **`createTestRelay(options?)`** — async factory for
  a minimal libp2p relay (E2E tests)
- **`TestRelay`** — `multiaddr`, `peerId`, `stop()`
- **`TestRelayOptions`** — `port?: number`

## Features

- **Synchronous sync** — Y.Doc update observers
  propagate edits immediately, no async gaps
- **Disconnect / reconnect** — suppress sync between
  peers, then flush pending state on reconnect
- **Partition / heal** — isolate groups of peers;
  `heal()` reconnects everyone and merges state
- **Convergence check** — `isConverged()` compares
  state vectors across all peers and channels
- **Settle** — `settle()` waits for all pending
  delayed updates when latency simulation is active
- **Late join** — new peers receive existing state
  on creation
- **Multi-channel** — each peer gets one Y.Doc per
  channel, all synced independently

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
