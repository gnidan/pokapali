import type { PeerPresenceResult } from "@pokapali/react";

export function PeerPresenceIndicator({ state, label }: PeerPresenceResult) {
  const dotClass =
    "poka-peer-presence__dot" + ` poka-peer-presence__dot--${state}`;

  return (
    <span
      className={`poka-peer-presence poka-peer-presence--${state}`}
      role="status"
      aria-label={label}
      data-testid="peer-presence"
    >
      <span className={dotClass} aria-hidden="true" />
      <span className="poka-peer-presence__label">{label}</span>
    </span>
  );
}
