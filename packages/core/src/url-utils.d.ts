/**
 * Extract a short document ID from a capability URL.
 * The URL path is `<base>/doc/<ipnsName>`. Long IPNS
 * names (>12 chars) are truncated for display.
 */
export declare function docIdFromUrl(url: string): string;
/**
 * Truncate a capability URL's hash fragment for
 * display. The fragment contains encoded key material
 * and is typically 100+ characters. This shows the
 * first 8 and last 8 characters with an ellipsis.
 */
export declare function truncateUrl(url: string): string;
//# sourceMappingURL=url-utils.d.ts.map