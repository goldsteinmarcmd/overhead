#!/usr/bin/env bash
# Refresh CelesTrak GP element sets into data/raw-*.txt
# Usage: ./fetch.sh [--enrichment] [--excerpts]
#   --enrichment  also rebuild data/enrichment.json from UCS (+ narrative links)
#   --excerpts    with --enrichment, fetch eoPortal / NSSDCA page excerpts
set -euo pipefail
cd "$(dirname "$0")"
DATA=data
BASE='https://celestrak.org/NORAD/elements/gp.php'

WANT_ENRICHMENT=0
ENRICH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --enrichment) WANT_ENRICHMENT=1 ;;
    --excerpts) ENRICH_ARGS+=(--excerpts) ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

GROUPS=(
  active
  stations
  starlink
  oneweb
  iridium-NEXT
  gps-ops
  glo-ops
  galileo
  beidou
  geo
  intelsat
  ses
  weather
  goes
  resource
  science
  planet
  spire
  military
)

mkdir -p "$DATA"
echo "Fetching ${#GROUPS[@]} CelesTrak GP groups…"

for g in "${GROUPS[@]}"; do
  out="$DATA/raw-${g}.txt"
  echo "  $g → $out"
  curl -fsSL --retry 3 --retry-delay 2 "${BASE}?GROUP=${g}&FORMAT=tle" -o "$out"
  # Be polite to CelesTrak
  sleep 0.4
done

echo "Done TLEs. Run: node build.js"
if [[ "$WANT_ENRICHMENT" -eq 1 ]]; then
  echo "Building enrichment (UCS + narrative links)…"
  # catalog.json preferred for filtering; build.js can run before or after.
  if [[ ${#ENRICH_ARGS[@]} -gt 0 ]]; then
    arch -arm64 node scripts/build-enrichment.js "${ENRICH_ARGS[@]}"
  else
    arch -arm64 node scripts/build-enrichment.js
  fi
fi
