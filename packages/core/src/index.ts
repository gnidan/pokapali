import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  Capability,
  CapabilityGrant,
} from "@pokapali/capability";
import type { CID } from "multiformats/cid";

export interface CollabLibOptions {
  appId?: string;
  namespaces: string[];
  primaryNamespace?: string;
}

export type DocStatus =
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "unpushed-changes";

export interface CollabDoc {
  subdoc(ns: string): Y.Doc;
  readonly awareness: Awareness;
  readonly capability: Capability;
  readonly adminUrl: string | null;
  readonly writeUrl: string | null;
  readonly readUrl: string;
  inviteUrl(grant: CapabilityGrant): string;
  readonly status: DocStatus;
  pushSnapshot(): Promise<void>;
  on(
    event: "snapshot-recommended",
    cb: () => void
  ): void;
  on(
    event: "snapshot-applied",
    cb: () => void
  ): void;
  off(event: string, cb: () => void): void;
  history(): Promise<Array<{
    cid: CID;
    seq: number;
    ts: number;
  }>>;
  loadVersion(
    cid: CID
  ): Promise<Record<string, Y.Doc>>;
  destroy(): void;
}

export interface CollabLib {
  create(): Promise<CollabDoc>;
  open(url: string): Promise<CollabDoc>;
}

export function createCollabLib(
  options: CollabLibOptions
): CollabLib {
  throw new Error("not implemented");
}
