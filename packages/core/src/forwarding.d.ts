export interface ForwardingRecord {
    oldIpnsName: string;
    newIpnsName: string;
    newUrl: string;
    signature: Uint8Array;
}
export declare function createForwardingRecord(oldIpnsName: string, newIpnsName: string, newUrl: string, rotationKey: Uint8Array): Promise<ForwardingRecord>;
export declare function encodeForwardingRecord(record: ForwardingRecord): Uint8Array;
export declare function decodeForwardingRecord(bytes: Uint8Array): ForwardingRecord;
export declare function verifyForwardingRecord(record: ForwardingRecord, rotationKey: Uint8Array): Promise<boolean>;
export declare function storeForwardingRecord(oldIpnsName: string, encoded: Uint8Array): void;
export declare function lookupForwardingRecord(ipnsName: string): Uint8Array | undefined;
export declare function clearForwardingStore(): void;
//# sourceMappingURL=forwarding.d.ts.map