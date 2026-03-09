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
