import type { PokapaliApp } from "@pokapali/core";

// Lazy-init pokapali: the P2P stack (~1.3MB min)
// only loads when the user creates or opens a doc.
let appPromise: Promise<PokapaliApp> | null = null;

export function getApp(): Promise<PokapaliApp> {
  if (appPromise) return appPromise;

  // Persist across Vite HMR to avoid duplicate
  // Helia/WebRTC instances on hot reload
  if (import.meta.hot?.data.app) {
    appPromise = Promise.resolve(import.meta.hot.data.app as PokapaliApp);
    return appPromise;
  }

  appPromise = import("@pokapali/core").then(({ pokapali }) => {
    const params = new URLSearchParams(window.location.search);
    const noCache = params.get("noCache") === "1";
    const noP2P =
      params.get("noP2P") === "1" ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__POKAPALI_NO_P2P === true;
    const peersParam = params.get("bootstrapPeers");
    const bootstrapPeers = peersParam
      ? peersParam.split(",").filter(Boolean)
      : undefined;
    const instance = pokapali({
      appId: "pokapali-example",
      channels: ["content", "comments"],
      origin:
        window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, ""),
      persistence: !noCache,
      p2p: !noP2P,
      ...(bootstrapPeers ? { bootstrapPeers } : {}),
    });
    if (import.meta.hot) {
      import.meta.hot.data.app = instance;
    }
    return instance;
  });

  return appPromise;
}
