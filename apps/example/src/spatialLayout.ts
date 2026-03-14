/**
 * Resolve overlapping comment cards by pushing
 * them down so they don't overlap.
 *
 * Input: items sorted by desiredY.
 * Output: adjusted Y positions with minimum gap.
 */

const MIN_GAP = 8;

export interface LayoutItem {
  id: string;
  desiredY: number;
  height: number;
}

export interface PositionedItem {
  id: string;
  y: number;
}

export function spatialLayout(items: LayoutItem[]): PositionedItem[] {
  const sorted = [...items].sort((a, b) => a.desiredY - b.desiredY);
  const result: PositionedItem[] = [];
  let nextY = 0;

  for (const item of sorted) {
    const y = Math.max(item.desiredY, nextY);
    result.push({ id: item.id, y });
    nextY = y + item.height + MIN_GAP;
  }

  return result;
}
