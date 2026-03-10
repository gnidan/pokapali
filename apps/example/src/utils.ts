export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatAge(timestamp: number): string {
  const sec = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1000),
  );
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) {
    return `${Math.round(sec / 60)}m ago`;
  }
  if (sec < 86400) {
    return `${Math.round(sec / 3600)}h ago`;
  }
  return `${Math.round(sec / 86400)}d ago`;
}
