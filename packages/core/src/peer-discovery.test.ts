import { describe, it, expect } from "vitest";
import { extractWssAddrs } from "./peer-discovery.js";

const PID = "12D3KooWTestPeerId";

describe("extractWssAddrs", () => {
  it("filters to /ws/ addresses", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws",
      "/ip4/1.2.3.4/tcp/4001",
      "/ip4/1.2.3.4/tcp/4001/ws/p2p/" + PID,
    ];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result).toHaveLength(2);
  });

  it("skips /p2p-circuit addrs", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws" +
        "/p2p-circuit/p2p/other",
    ];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result).toHaveLength(0);
  });

  it("in HTTPS context, skips plain ws", () => {
    const addrs = [
      "/ip4/1.2.3.4/tcp/4001/ws",
      "/ip4/1.2.3.4/tcp/443/tls/ws",
    ];
    const result = extractWssAddrs(
      PID, addrs, true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].toString()).toContain(
      "/tls/",
    );
  });

  it("appends /p2p/ suffix if missing", () => {
    const addrs = ["/ip4/1.2.3.4/tcp/4001/ws"];
    const result = extractWssAddrs(
      PID, addrs, false,
    );
    expect(result[0].toString()).toContain(
      `/p2p/${PID}`,
    );
  });

  it("preserves existing /p2p/ suffix", () => {
    const addr =
      "/ip4/1.2.3.4/tcp/4001/ws/p2p/" + PID;
    const result = extractWssAddrs(
      PID, [addr], false,
    );
    // Should not double the /p2p/ suffix
    const str = result[0].toString();
    const count =
      (str.match(/\/p2p\//g) || []).length;
    expect(count).toBe(1);
  });
});
