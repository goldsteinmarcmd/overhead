# Overhead

Interactive globe of Earth-orbiting satellites — what they’re for, what they’ve done, and what it cost to put them there.

**Live site:** https://goldsteinmarcmd.github.io/overhead/

## What it shows

- ~16k tracked objects from [CelesTrak](https://celestrak.org) TLEs, propagated with SGP4
- Filters by category, operator, and country
- Hand-researched dossiers (cost, purpose, results) for notable missions
- Point sizes at true scale vs Earth by default; Extra → Enlarge ×2,500 for readable relative sizes
- Optional last-known imagery via NASA GIBS for mapped sensors
- Address lookup (OpenStreetMap Nominatim) to see what’s overhead

## Analytics (first-party, GDPR)

Optional consent-gated analytics on Google Cloud free tier (Cloud Run + BigQuery, `europe-west1`). Not Google Analytics ads products.

- Collector / dashboard: see Cloud Run service `overhead-analytics` in project `overhead-analytics-260730`
- Site sends events only after **Accept** on the consent banner ([privacy.html](privacy.html))
- Redeploy collector: `./analytics/deploy.sh`
- Open dashboard: Cloud Run `/dashboard` URL + secret from Secret Manager:

```bash
gcloud secrets versions access latest --secret=dashboard-secret --project=overhead-analytics-260730
```

## Local development

```bash
python3 -m http.server 8877 --bind 127.0.0.1
# open http://127.0.0.1:8877/
```

Refresh catalog (optional):

```bash
./fetch.sh
node build.js
node scripts/build-enrichment.js          # UCS purpose + narrative links
# node scripts/build-enrichment.js --excerpts   # also pull eoPortal/NSSDCA blurbs
```

Or in one shot after TLEs: `./fetch.sh --enrichment` (add `--excerpts` for page blurbs).

## Data notes

- **Positions** — CelesTrak TLEs + SGP4 (visualization-grade, not ops-grade)
- **Costs / purpose / results** — hand-curated dossiers; each figure has a confidence label
- **Auto purpose** — [UCS Satellite Database](https://www.ucs.org/resources/satellite-database) joined by NORAD (name fallback), as of 2023-05-01 (UCS paused updates)
- **Mission notes** — ESA eoPortal + NASA NSSDCA links (and Gunter citation links when already listed in UCS); no Gunter body scrape
- No API keys required for the public site (Nominatim + GIBS are keyless public endpoints)
