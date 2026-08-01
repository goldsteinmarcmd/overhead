# Overhead — Cursor project handoff

**Project:** `/Users/marcgoldstein/Documents/satellites`  
**Product name:** Overhead  
**Tagline:** What they’re for, what they’ve done, and what it cost to put there.  
**Stack:** Static site — HTML/CSS/vanilla JS modules, Three.js, satellite.js (SGP4), Node build scripts  
**Git:** Root folder is **not** a git repo yet (`Untitled/.git` is incidental only). No remote.  
**Handoff date:** 2026-07-29

---

## What this product is

A browser globe of ~16k active catalog objects (CelesTrak TLEs), with:

1. **Live positions** via client-side SGP4  
2. **Hand-researched dossiers** for notable missions: purpose, results, costs, timeline  
3. **Last-known Earth browse imagery** (NASA GIBS) for selected imagers, with UTC timestamp  
4. **Filters** by category, operator (owner), country, and has-picture  
5. **Address lookup → what's overhead**: type an address, the globe flies there, and the panel lists everything above that horizon right now with elevation / compass bearing / slant range  

**Product intent (clarified mid-project):** help someone understand *why* each satellite exists and *what it has achieved*, with cost as supporting context — not another Flightradar24-of-space.

**Competitive note:** Many apps do the live globe (KeepTrack, azmth, Cosmik, stuffin.space). Almost none combine live catalog + purpose/results + confidence-labeled costs. See prior chat [Satellite comps](bb41b9af-13de-4c5b-8c15-e6edfa1592e1).

---

## How to run

```bash
cd /Users/marcgoldstein/Documents/satellites

# Refresh TLEs (polite curl; ~20 CelesTrak groups)
./fetch.sh

# Rebuild catalog + meta + by-operator / by-country
node build.js

# Serve statically (any static server; earlier sessions used ~8877)
python3 -m http.server 8877
# → http://127.0.0.1:8877/
```

Requires a modern browser with WebGL. ES modules + import map for `three`.

---

## Repo layout

```
satellites/
├── index.html              # Shell: brand, search + address fields, filters, HUD, panel
├── css/app.css             # Full UI (no framework)
├── js/
│   ├── app.js              # Globe, propagation, filters, panel, place pin
│   ├── imagery.js          # NASA GIBS last-browse fetch + stamp
│   ├── geocode.js          # Address → lat/lon (Nominatim) + "lat, lon" parsing
│   └── sky.js              # lat/lon → scene, look angles, overhead search
├── .claude/launch.json     # Dev-server config for the Claude Code preview pane
├── scripts/
│   ├── patch-purpose-results.js   # Seeds purpose/results into curated.json
│   └── build-enrichment.js        # UCS + eoPortal/NSSDCA/Gunter → enrichment.json
├── build.js                # TLE → catalog.json + meta + indexes
├── fetch.sh                # Download raw-*.txt from CelesTrak (+ optional --enrichment)
├── data/
│   ├── curated.json        # Hand dossiers (costs, purpose, results)
│   ├── enrichment.json     # Built: UCS purpose + narrative links by NORAD
│   ├── catalog.json        # Built: all sats + fields
│   ├── meta.json           # Built: counts, legend, operators
│   ├── by-operator.json    # Built: operator → sat list
│   ├── by-country.json     # Built: country → sat list
│   ├── raw-*.txt           # Fetched TLEs
│   ├── supplement.txt      # Extra TLEs if needed
│   └── _index.json         # Helper index
├── assets/                 # Earth day / night / topo textures
└── vendor/                 # three.module.js, OrbitControls, satellite.min.js
```

---

## Chronology — what Cursor built

Sessions spanned one evening (2026-07-28 → early 2026-07-29). An early chat hit an API limit; work was reconstructed and continued from disk state.

### 1. Data pipeline + catalog (foundation)

| Piece | Role |
|--------|------|
| `fetch.sh` | Pulls GP TLEs for active, stations, starlink, oneweb, GNSS, weather, science, military, etc. |
| `build.js` | Parses TLEs; classifies by **ordered regex rules** (category, country/owner id, operator string); attaches dossier keys from `curated.json`; writes `catalog.json`, `meta.json`, `by-operator.json`, `by-country.json` |
| `data/curated.json` | ~46 hand dossiers: stations, science, EO, weather, GNSS fleets, Starlink/OneWeb/Iridium, GEO/military exemplars, Vanguard 1 |

**Accuracy model (explained to user):**  
- **Positions** — CelesTrak TLEs + SGP4 (good for visualization; not cm-level ops).  
- **Classification** — rule-based from names; imperfect for obscure sats.  
- **Costs / purpose / results** — curated; each figure has `confidence`: `published` \| `reported` \| `estimated` \| `undisclosed`.

### 2. Three.js globe UI

- Full-bleed canvas Earth (day/night/topo textures), auto-rotate, OrbitControls  
- Point cloud of all catalog sats, colored by category  
- Click to select; optional **selected orbit** line; **pause time** + live clock  
- Search by name / NORAD  
- Detail **panel** (not hover tooltips) for the selected object  
- ECEF positions locked to Earth texture (bug fixed: no independent earth spin)

### 3. Filters & lookup (iterated heavily)

| Feature | Behavior |
|---------|----------|
| **Category** tab | Toggle mission classes (comms-leo, earth, …) |
| **Owner** tab | **Operators** (SpaceX, Planet Labs, …) — not countries; find box; expandable fleets |
| **Country** tab | US / China / … expandable lists |
| **Select all / Unselect all** | Applies to active tab; Owner bulk ignores search filter for true all/none (after bugfix) |
| **All / Has picture / No picture** | Stacks with other filters; “has picture” = GIBS mapping in `imagery.js` |

Fixes worth remembering:

- Owner labels were **invisible** because flex was crushing row height — fixed by stopping shrink on filter children.  
- Owner row click originally only expanded; now **checkbox toggles visibility**, expand is separate.  
- Bulk select on Owner must clear/set the full operator set, not just search hits.

### 4. Last-known imagery (GIBS)

`js/imagery.js` + panel slot in `app.js`:

- For mapped NORAD / constellation IDs, fetch a recent **NASA GIBS** browse frame  
- Show **UTC datetime** on the caption  
- Retry older dates when today’s mosaic is empty / too small  
- Wired imagers include: Terra, Aqua, Landsats, Sentinel-1/2/3 variants, VIIRS (SNPP, NOAA-20/21), GOES East/West series, Himawari, etc.  
- **Not** available for altimeters/radiometers (ICESat-2, SWOT, Jason, SMAP, GPM, GRACE, MetOp…) or commercial fleets without public GIBS layers (Planet, etc.)

Related chat: [Satellite last-image tooltips](6b773abb-7120-4c15-8664-3070c0ef9626).

### 5. Purpose + results (product pivot)

User clarified goal: purpose of each satellite + results achieved.

| Deliverable | Detail |
|-------------|--------|
| Schema | `purpose` `{ summary, users[], instruments?, measures? }` and `results` `{ headline, bullets[{text,year,confidence,source}], stillDoing }` |
| Seed set | **24** dossiers with full bullets (planned “20” including pairs: Landsat 8/9, Terra/Aqua, Suomi/NOAA-20, Jason/Sentinel-6, …) |
| Stubs | Remaining **22** dossiers: purpose one-liner + empty results |
| UI | Panel order: **Purpose → Results → Cost → timeline facts → sources** |
| Script | `scripts/patch-purpose-results.js` — re-runnable seeder (already applied to `curated.json`) |

Bare (non-dossier) sats get a category fallback purpose line only.

Related chat: [Satellite comps](bb41b9af-13de-4c5b-8c15-e6edfa1592e1) (this thread).

### 6. Address lookup + "what's overhead" (2026-07-29)

Second input under the satellite search: **"Zoom to an address or city…"**.

| Piece | Behavior |
|-------|----------|
| Geocoding | `js/geocode.js` → Nominatim (`format=jsonv2`), 550 ms debounce, ≥1.1 s between requests, in-memory cache, `AbortController` per keystroke |
| Direct coords | `"48.8584, 2.2945"` is parsed locally — no network call |
| Picking | Typing shows candidates; **Enter applies the top hit**; clicking picks a specific one |
| Camera | Quaternion-slerp flight to sit over the point at 1.85 Earth radii (~1.2 s), cancelled the moment the user grabs the globe |
| Pin | Amber dot + pulsing tangent ring + mast, in the ECEF frame so it stays locked to the ground |
| Rays | Sight lines from the pin to the 14 highest satellites |
| Sky panel | Reuses `#panel`: elevation threshold (Horizon / 10° / 30°, default 10°), live count, top 40 rows sorted by elevation, each with category swatch, elevation, compass bearing, slant range |
| Live update | Recomputed every 1.5 s (slower than the 750 ms propagation so rows stay clickable); rows are **reconciled in place**, not rebuilt |
| Navigation | Row → satellite dossier with a `← Overhead at <place>` back button and a look-angle line; closing the dossier steps back to the list; closing the list keeps the pin (click the pin to reopen); **Clear location** removes it |
| Filters | The list respects the category / owner / country filters, so "only Starlink overhead" works |

**Math notes.** The pin uses spherical lat/lon → scene, because the globe is a sphere with a plate-carrée texture. Look angles use satellite.js WGS84 (`geodeticToEcf` / `ecfToLookAngles`), reading ECEF back out of the render buffer instead of re-running SGP4 for 16k objects. The two conventions differ by the geodetic-vs-geocentric latitude offset (≤0.19°, verified 0.000° at the equator) — irrelevant visually, correct where it matters.

**Verified against fresh SGP4** with time paused: elevations within ~1°, ranges within 2 km, compass bearings exact.

---

## Curated dossier inventory

**Fully seeded purpose + results (~24):**  
ISS, Hubble, Chandra, Terra, Aqua, Landsat 8/9, ICESat-2, SWOT, Sentinel-1A/2A, Suomi NPP, NOAA-20, GOES-16, GPS III, Galileo, Starlink, SBIRS GEO-1, Sentinel-6, Jason-3, SMAP, GPM Core, GRACE-FO, Vanguard 1  

**Purpose stub only (examples):**  
Tiangong, Fermi, XMM, Swift, NuSTAR, IXPE, GOES-19, Himawari, MetOp-C, BeiDou/GLONASS/QZSS, OneWeb, Iridium, Intelsat/SES/ViaSat, TDRS, AEHF/MUOS/WGS, Planet Doves  

**Round-2 fill candidates** (from earlier plan): science X-ray/gamma set, Planet, OneWeb/Iridium, remaining GEO commercial, Chinese GNSS, Tiangong.

---

## Key code entry points

| Concern | Where |
|---------|--------|
| Classification rules | `build.js` → `RULES`, `CATEGORIES`, `OWNERS` |
| Runtime state / filters | `js/app.js` → `state`, `buildFilters`, `propagate` |
| Detail panel | `js/app.js` → `renderPanel`, `renderPurpose`, `renderResults` |
| GIBS mapping | `js/imagery.js` → `imageryFor`, `fillLastImage` |
| Address lookup | `js/geocode.js` → `geocode`, `parseLatLon` |
| Overhead math | `js/sky.js` → `latLonToScene`, `findOverhead`, `lookAngleAt` |
| Place pin + sky panel | `js/app.js` → `setPlace`, `flyTo`, `showSky`, `updateSky`, `renderSkyRows` |
| Dossier content | `data/curated.json` (`_schema` documents confidence + fields) |

Catalog row fields (see `catalog.json` `fields`):  
`norad, name, l1, l2, cat, owner, orbit, perigeeKm, apogeeKm, incDeg, dossier, operator`

---

## Open-source comps (study vs ship)

**Safe to study / MIT-ish:** StuffInSpace lineage, satellite.js, Cosmos, SatDeck (verify LICENSE).  
**AGPL (ideas only unless you accept AGPL):** KeepTrack.  
**Closed (UX reference only):** azmth, Cosmik, satellitemap.space, Track The Sky.  
**No license on public repo:** Exosphere — don’t copy.

Data sources for purpose scale-out (now wired): UCS Satellite Database (purpose), eoPortal / NSSDCA (mission narratives), Gunter’s Space Page (citation links only).

### Enrichment pipeline

```bash
node scripts/build-enrichment.js            # UCS → data/enrichment.json
node scripts/build-enrichment.js --excerpts # + eoPortal/NSSDCA meta blurbs
./fetch.sh --enrichment [--excerpts]        # TLEs then enrichment
```

- Join: **NORAD preferred**, normalized name fallback.
- Client loads `data/enrichment.json`; bare sats show UCS purpose; dossiers can show Mission notes links.
- UCS official DB paused after **2023-05-01**; NSSDCA may be intermittently offline (links still emitted from COSPAR).
- Gunter: **no body scrape** — only URLs already present in UCS source columns.

---

## Known gaps / next work

1. **Git** — initialize repo, `.gitignore` for nothing critical (raw TLEs are large but useful; decide whether to commit or fetch CI-side).  
2. **Fill stub dossiers** — especially Planet, OneWeb, Tiangong, remaining science.  
3. **Enrichment freshness** — UCS paused; consider community mirrors (e.g. Hugging Face) or Space-Track SATCAT for post-2023 objects.  
4. **Imagery coverage** — more GIBS NORADs; no good “last picture” for non-imagers (show instrument product instead?).  
5. **Operator name cleanup** — build rules produced some duplicate-ish operator strings (e.g. Planet Labs vs Planet Labs PBC).  
6. **Deploy** — still local static only; no hosting yet.  
7. **Tests** — none; smoke-check: load page, search Hubble, toggle Owner select-all, Has picture; search a bare UCS sat (e.g. non-dossier EO) for purpose + Mission notes.  
8. **Performance** — ~16k points OK; Starlink density dominates. KeepTrack-style tricks if it slows on mobile.  
9. **Geocoder** — Nominatim has no key but allows ~1 req/s and can't be identified by User-Agent from a browser. Swap in a keyed geocoder (Mapbox / MapTiler / Google) before this gets real traffic; only `js/geocode.js` changes.  
10. **Pass predictions** — the sky panel is "right now" only. Next obvious step: *when* the ISS (or any pick) next rises over the pinned address, plus rise/set times.  
11. **Observer altitude** — hard-coded to 0 m. Nominatim doesn't return elevation; matters only for very high sites.

---

## Related Cursor chats

| Chat | ID | Focus |
|------|-----|--------|
| Continue the plan (globe + pipeline resume) | [e5bfd92f…](e5bfd92f-28b9-454f-8e09-2b9273c710d6) | fetch/build, globe UI, owner/country filters, expandables |
| Last-image + filter fixes | [6b773abb…](6b773abb-7120-4c15-8664-3070c0ef9626) | GIBS imagery, select-all, has-picture, owner visibility bugs |
| Comps + purpose/results | [bb41b9af…](bb41b9af-13de-4c5b-8c15-e6edfa1592e1) | competitive map, schema, seed 24, panel wiring, this handoff |

---

## Quick verification checklist

- [ ] `./fetch.sh && node build.js` completes  
- [ ] Page loads; status shows ~16k objects  
- [ ] Search **Hubble** → purpose, results, cost, optional imagery N/A (science)  
- [ ] Search **Terra** → GIBS image + UTC stamp  
- [ ] Owner tab: SpaceX visible; Select all / Unselect all toggles globe density  
- [ ] Has picture → sparse set of imagers only  
- [ ] Country expand → click sat opens panel  
- [ ] Address box: type **1600 Pennsylvania Avenue** → candidate list → Enter/click flies to DC, pin lands on the mid-Atlantic coast  
- [ ] Overhead list fills, sorted by elevation; Horizon / 10° / 30° change the counts  
- [ ] Click a row → dossier with look angles + `← Overhead at …`; back returns to the list  
- [ ] Close the panel → pin stays; click the pin → list reopens; **Clear location** removes it  
- [ ] Type `48.8584, 2.2945` → flies to Paris with no network call  

---

*Generated as a Cursor handoff for Overhead. Prefer updating this file when shipping deploy, git init, or the next dossier batch.*
