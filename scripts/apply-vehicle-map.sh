#!/usr/bin/env bash
# Apply a brand's vehicle-entity name map to the dashboard cards.
#
# Renames the BYD-canonical entity suffixes that follow __VEHICLE__ to the
# brand's real suffixes, so non-BYD cars work without hand-editing cards.
#
#   scripts/apply-vehicle-map.sh <brand> [cards-dir]
#
# Map format (vehicle-maps/<brand>.map): one "canonical real" pair per line.
# Blank lines and # comments are ignored. real == canonical is a no-op.
set -euo pipefail
cd "$(dirname "$0")/.."

brand="${1:?usage: apply-vehicle-map.sh <brand> [cards-dir]}"
cards_dir="${2:-cards}"
map="vehicle-maps/${brand}.map"

[ -f "$map" ] || { echo "ERROR: map not found: $map" >&2; exit 1; }
[ -d "$cards_dir" ] || { echo "ERROR: cards dir not found: $cards_dir" >&2; exit 1; }

# Apply each mapping with a portable, idempotent boundary.
# Two expressions: token followed by a non-word char (mid-line, e.g. quote
# or space), and token at end of line. BSD/busybox sed lack \b, so we match
# an explicit non-word class plus the $ anchor instead.
while read -r canonical real _; do
  [ -z "${canonical:-}" ] && continue
  case "$canonical" in \#*) continue ;; esac
  [ -z "${real:-}" ] && continue
  [ "$real" = "$canonical" ] && continue
  for f in "$cards_dir"/*.yaml; do
    sed -E \
      -e "s/__VEHICLE___${canonical}([^A-Za-z0-9_])/__VEHICLE___${real}\1/g" \
      -e "s/__VEHICLE___${canonical}\$/__VEHICLE___${real}/g" \
      "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
done < "$map"

echo "applied $map to $cards_dir/"
