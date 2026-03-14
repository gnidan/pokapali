#!/usr/bin/env bash
set -euo pipefail
# Check memory files for staleness indicators.
#
# Flags:
#   - Files not modified in N+ days (default: 3)
#   - Files containing hardcoded counts/commit hashes
#     that may have drifted from reality
#   - Files over a size threshold (likely need splitting)
#   - MEMORY.md line count vs. 200-line limit
#
# Usage:
#   bin/check-memory-staleness.sh          # default 3 days
#   bin/check-memory-staleness.sh --days 7 # custom threshold

DAYS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    *) echo "Usage: $0 [--days N]"; exit 1 ;;
  esac
done

MEMORY_DIR="${MEMORY_DIR:-$HOME/.claude/projects/-Users-gnidan-src-pokapali/memory}"

if [ ! -d "$MEMORY_DIR" ]; then
  echo "ERROR: memory directory not found: $MEMORY_DIR"
  exit 1
fi

ISSUES=0
WARNINGS=0

issue() {
  ISSUES=$((ISSUES + 1))
  echo "  ISSUE: $1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  echo "  WARN:  $1"
}

echo "=== Memory Staleness Check ==="
echo "  directory: $MEMORY_DIR"
echo "  threshold: $DAYS days"
echo ""

# 1. MEMORY.md line count
echo "--- MEMORY.md size ---"
MEMLINES=$(wc -l < "$MEMORY_DIR/MEMORY.md")
echo "  $MEMLINES lines (limit: 200)"
if [ "$MEMLINES" -gt 200 ]; then
  issue "MEMORY.md is $MEMLINES lines (over 200-line limit — agents see truncated index)"
elif [ "$MEMLINES" -gt 180 ]; then
  warn "MEMORY.md is $MEMLINES lines (approaching 200-line limit)"
else
  echo "  OK"
fi
echo ""

# 2. Files not modified in N+ days
echo "--- Files older than $DAYS days ---"
OLD_COUNT=0
while IFS= read -r file; do
  name=$(basename "$file")
  # skip MEMORY.md (index file, not a memory)
  [ "$name" = "MEMORY.md" ] && continue
  age_days=$(( ( $(date +%s) - $(stat -f %m "$file") ) / 86400 ))
  if [ "$age_days" -ge "$DAYS" ]; then
    OLD_COUNT=$((OLD_COUNT + 1))
    warn "$name — $age_days days old"
  fi
done < <(find "$MEMORY_DIR" -name '*.md' -type f | sort)
if [ "$OLD_COUNT" -eq 0 ]; then
  echo "  All files modified within $DAYS days"
fi
echo ""

# 3. Files with hardcoded counts/hashes that drift
echo "--- Potentially stale data patterns ---"
STALE_PATTERNS=(
  '[0-9]+ tests'
  '[0-9]+ unit'
  '[0-9]+ issues'
  '[0-9]+ open'
  '[0-9]+ closed'
  'HEAD.*: [0-9a-f]{7}'
  'commit.*[0-9a-f]{7,40}'
)
for file in "$MEMORY_DIR"/*.md; do
  name=$(basename "$file")
  [ "$name" = "MEMORY.md" ] && continue
  for pattern in "${STALE_PATTERNS[@]}"; do
    matches=$(grep -cEi "$pattern" "$file" 2>/dev/null || true)
    if [ "$matches" -gt 0 ]; then
      warn "$name: $matches lines match '$pattern' (may be stale)"
    fi
  done
done
echo ""

# 4. Large files that may need splitting
echo "--- Large files (over 10KB) ---"
LARGE_COUNT=0
while IFS= read -r file; do
  name=$(basename "$file")
  size=$(stat -f %z "$file")
  if [ "$size" -gt 10240 ]; then
    LARGE_COUNT=$((LARGE_COUNT + 1))
    size_kb=$((size / 1024))
    warn "$name — ${size_kb}KB"
  fi
done < <(find "$MEMORY_DIR" -name '*.md' -type f | sort)
if [ "$LARGE_COUNT" -eq 0 ]; then
  echo "  No oversized files"
fi
echo ""

# 5. Files not referenced in MEMORY.md
echo "--- Orphan files (not in MEMORY.md) ---"
ORPHAN_COUNT=0
for file in "$MEMORY_DIR"/*.md; do
  name=$(basename "$file")
  [ "$name" = "MEMORY.md" ] && continue
  if ! grep -qF "$name" "$MEMORY_DIR/MEMORY.md"; then
    ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
    warn "$name — not referenced in MEMORY.md"
  fi
done
if [ "$ORPHAN_COUNT" -eq 0 ]; then
  echo "  All files referenced in MEMORY.md"
fi
echo ""

# Summary
echo "==============================="
echo "  $ISSUES issues, $WARNINGS warnings"
if [ "$ISSUES" -gt 0 ]; then
  echo "  Fix issues before they cause agent confusion."
  exit 1
fi
if [ "$WARNINGS" -gt 5 ]; then
  echo "  Consider reviewing flagged files for staleness."
fi
