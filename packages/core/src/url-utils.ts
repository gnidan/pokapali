/**
 * Extract a short document ID from a capability URL.
 * The URL path is `<base>/doc/<ipnsName>`. Long IPNS
 * names (>12 chars) are truncated for display.
 */
export function docIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const docIdx = parts.indexOf("doc");
    if (docIdx >= 0 && parts[docIdx + 1]) {
      const id = parts[docIdx + 1]!;
      return id.length > 12 ? id.slice(0, 6) + "\u2026" + id.slice(-6) : id;
    }
  } catch {
    // malformed URL
  }
  return "unknown";
}

/**
 * Truncate a capability URL's hash fragment for
 * display. The fragment contains encoded key material
 * and is typically 100+ characters. This shows the
 * first 8 and last 8 characters with an ellipsis.
 */
export function truncateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hash = parsed.hash;
    if (hash.length > 20) {
      return (
        parsed.origin +
        parsed.pathname +
        "#" +
        hash.slice(1, 9) +
        "\u2026" +
        hash.slice(-8)
      );
    }
    return url;
  } catch {
    return url;
  }
}
