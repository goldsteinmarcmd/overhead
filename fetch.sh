#!/usr/bin/env bash
# Refresh CelesTrak GP element sets into data/raw-*.txt
# Usage: ./fetch.sh
set -euo pipefail
cd "$(dirname "$0")"
DATA=data
BASE='https://celestrak.org/NORAD/elements/gp.php'

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

echo "Done. Run: node build.js"
