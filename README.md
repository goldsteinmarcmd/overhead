# Overhead

Interactive globe of Earth-orbiting satellites — what they’re for, what they’ve done, and what it cost to put them there.

**Live site:** https://goldsteinmarcmd.github.io/overhead/

## What it shows

- ~16k tracked objects from [CelesTrak](https://celestrak.org) TLEs, propagated with SGP4
- Filters by category, operator, and country
- Hand-researched dossiers (cost, purpose, results) for notable missions
- Point sizes scaled to real craft dimensions (relative ratios ×2,500 for visibility)
- Optional last-known imagery via NASA GIBS for mapped sensors
- Address lookup (OpenStreetMap Nominatim) to see what’s overhead

## Local development

```bash
python3 -m http.server 8877 --bind 127.0.0.1
# open http://127.0.0.1:8877/
```

Refresh catalog (optional):

```bash
./fetch.sh
node build.js
```

## Data notes

- **Positions** — CelesTrak TLEs + SGP4 (visualization-grade, not ops-grade)
- **Costs / purpose / results** — curated; each figure has a confidence label
- No API keys required for the public site (Nominatim + GIBS are keyless public endpoints)
