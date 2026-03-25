/**
 * Capability — describes permissions derived from a
 * {@link Credential}.
 */
import type { Credential } from "../credential.js";

/**
 * Describes the permissions derived from a set of
 * credential keys.
 */
export interface Capability {
  /** Channel names the holder can write to. */
  channels: Set<string>;
  /** True if the holder has the IPNS key needed
   *  to publish snapshots. */
  canPushSnapshots: boolean;
  /** True if the holder has the rotation key. */
  isAdmin: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Capability {
  /**
   * Describes the permissions to grant when narrowing
   * a credential.
   */
  export interface Grant {
    /** Channels to include. `undefined` preserves all
     *  source channels; `[]` removes all. */
    channels?: string[];
    /** Whether to include the IPNS key (snapshot
     *  publishing). Defaults to false. */
    canPushSnapshots?: boolean;
  }
}

/**
 * Companion object for the Capability type.
 */
export const Capability: {
  infer(credential: Credential, channels: string[]): Capability;
  narrow(credential: Credential, grant: Capability.Grant): Credential;
} = {
  infer(credential: Credential, channels: string[]): Capability {
    const writable = new Set<string>();
    if (credential.channelKeys) {
      for (const ch of channels) {
        if (ch in credential.channelKeys) {
          writable.add(ch);
        }
      }
    }
    return {
      channels: writable,
      canPushSnapshots: !!credential.ipnsKeyBytes,
      isAdmin: !!credential.rotationKey,
    };
  },

  narrow(credential: Credential, grant: Capability.Grant): Credential {
    const result: Credential = {};

    if (credential.readKey) {
      result.readKey = credential.readKey;
    }
    if (credential.awarenessRoomPassword) {
      result.awarenessRoomPassword = credential.awarenessRoomPassword;
    }

    if (grant.canPushSnapshots && credential.ipnsKeyBytes) {
      result.ipnsKeyBytes = credential.ipnsKeyBytes;
    }

    // rotationKey never narrowed (admin only)

    if (grant.channels === undefined) {
      if (credential.channelKeys) {
        result.channelKeys = {
          ...credential.channelKeys,
        };
      }
    } else if (grant.channels.length > 0) {
      const missing = grant.channels.filter(
        (ch) => !credential.channelKeys || !(ch in credential.channelKeys),
      );
      if (missing.length > 0) {
        throw new Error(
          "Capability.narrow: grant requests channels " +
            "not in source keys: " +
            missing.join(", "),
        );
      }
      const narrowed: Record<string, Uint8Array> = {};
      for (const ch of grant.channels) {
        narrowed[ch] = credential.channelKeys![ch]!;
      }
      result.channelKeys = narrowed;
    }

    return result;
  },
};
