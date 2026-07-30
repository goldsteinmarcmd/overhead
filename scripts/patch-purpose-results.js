#!/usr/bin/env node
/**
 * Adds purpose + results to curated dossiers.
 * Full narratives for the seed set; light stubs for the rest.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'curated.json');
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));

doc._schema.note =
  'Hand-researched dossiers. Orbital elements come from CelesTrak/Space-Track. Costs, purpose, and results are compiled from agency budgets, audits, contracts, mission pages, and peer-reviewed or official science summaries — confidence labeled per figure.';

doc._schema.fields.purpose =
  'Why the spacecraft (or constellation) exists: one-sentence intent, users, key instruments/measures.';
doc._schema.fields.results =
  'What it has delivered: headline outcome, dated bullets with sources, and what it still produces today.';

function P(summary, opts = {}) {
  return {
    summary,
    users: opts.users || ['science'],
    instruments: opts.instruments || undefined,
    measures: opts.measures || undefined,
  };
}

function R(headline, bullets, stillDoing) {
  return {
    headline,
    bullets: bullets.map((b) => ({
      text: b.text,
      year: b.year ?? null,
      confidence: b.confidence || 'published',
      source: b.source,
    })),
    stillDoing,
  };
}

function stub(summary, users = ['civil']) {
  return {
    purpose: P(summary, { users }),
    results: {
      headline: 'Results dossier not yet researched for this entry.',
      bullets: [],
      stillDoing: null,
    },
  };
}

/** Full seed content keyed by shortName || name */
const SEED = {
  ISS: {
    purpose: P(
      'Provide a continuously crewed laboratory in low Earth orbit for science, technology demonstration, and international cooperation.',
      {
        users: ['science', 'civil'],
        instruments: ['Expedition labs', 'External payloads', 'Human research facilities'],
        measures: ['microgravity biology', 'materials science', 'Earth observation from station'],
      }
    ),
    results: R(
      'Longest continuous human presence in space and a workhorse for microgravity research.',
      [
        {
          text: 'Permanently crewed since November 2000 — over 25 years of unbroken habitation.',
          year: 2000,
          confidence: 'published',
          source: 'NASA ISS program',
        },
        {
          text: 'Thousands of investigations flown; results span protein crystals, combustion, Earth imaging, and human physiology for deep-space flight.',
          year: 2024,
          confidence: 'reported',
          source: 'NASA ISS Research Overview / annual reports',
        },
        {
          text: 'Enabled commercial cargo/crew (SpaceX, Northrop, Boeing) and private astronaut missions as a market pathfinder.',
          year: 2020,
          confidence: 'published',
          source: 'NASA Commercial Crew / CRS program summaries',
        },
      ],
      'Crewed research, Earth observation, tech demos; planned transition to commercial LEO destinations ~2030.'
    ),
  },

  Hubble: {
    purpose: P(
      'Observe the universe in ultraviolet, visible, and near-infrared from above Earth’s atmosphere.',
      {
        users: ['science'],
        instruments: ['WFC3', 'ACS', 'STIS', 'COS'],
        measures: ['deep-field imaging', 'cosmic expansion', 'exoplanet atmospheres'],
      }
    ),
    results: R(
      'Transformed modern astronomy — the public and scientific picture of deep space.',
      [
        {
          text: 'Helped establish accelerating cosmic expansion / dark energy evidence (with ground surveys; 2011 Physics Nobel).',
          year: 1998,
          confidence: 'published',
          source: 'STScI / Nobel Committee Type Ia supernova work',
        },
        {
          text: 'Hubble Ultra Deep Field and successors imaged galaxies within ~400 Myr of the Big Bang.',
          year: 2004,
          confidence: 'published',
          source: 'STScI HUDF',
        },
        {
          text: 'Still drives ~1,000+ peer-reviewed papers per year decades after launch.',
          year: 2024,
          confidence: 'reported',
          source: 'STScI annual reports',
        },
      ],
      'Guest-observer program; public archive at MAST (STScI).'
    ),
  },

  Chandra: {
    purpose: P(
      'Map the high-energy universe in X-rays — black holes, galaxy clusters, supernova remnants.',
      {
        users: ['science'],
        instruments: ['ACIS', 'HRC', 'HETG', 'LETG'],
        measures: ['X-ray spectra', 'cluster gas temperatures', 'compact-object accretion'],
      }
    ),
    results: R(
      'Gold-standard X-ray observatory for black holes, dark matter, and explosive astrophysics.',
      [
        {
          text: 'Resolved structure in galaxy-cluster gas and constrained dark-matter / cosmology via cluster physics.',
          year: 2000,
          confidence: 'published',
          source: 'Chandra X-ray Center science highlights',
        },
        {
          text: 'Imaged jets and accretion near stellar-mass and supermassive black holes with sub-arcsecond resolution.',
          year: 2001,
          confidence: 'published',
          source: 'CXC / NASA Chandra mission pages',
        },
        {
          text: 'Decades-long archive remains a primary resource for multi-wavelength astronomy.',
          year: 2024,
          confidence: 'published',
          source: 'Chandra Data Archive',
        },
      ],
      'Guest-observer X-ray observations; archive at the Chandra X-ray Center.'
    ),
  },

  Terra: {
    purpose: P(
      'Flagship Earth Observing System platform for climate, atmosphere, land, and ocean processes.',
      {
        users: ['science', 'civil'],
        instruments: ['MODIS', 'ASTER', 'MISR', 'MOPITT', 'CERES'],
        measures: ['land cover', 'aerosols', 'radiation budget', 'fires'],
      }
    ),
    results: R(
      'Built the modern daily global view of land, clouds, fires, and Earth’s radiation budget.',
      [
        {
          text: 'MODIS (shared with Aqua) became the workhorse for fire detection, NDVI, snow cover, and ocean color.',
          year: 2000,
          confidence: 'published',
          source: 'NASA Terra / MODIS science team',
        },
        {
          text: 'CERES measurements underpin Earth’s energy imbalance and cloud-forcing climate records.',
          year: 2000,
          confidence: 'published',
          source: 'NASA CERES project',
        },
        {
          text: 'ASTER DEM and thermal products widely used for geology, volcanoes, and urban heat.',
          year: 2001,
          confidence: 'published',
          source: 'NASA/METI ASTER',
        },
      ],
      'Continuing climate and disaster-support data products via NASA EOSDIS (aging platform).'
    ),
  },

  Aqua: {
    purpose: P(
      'Afternoon Earth Observing System satellite focused on the water cycle and atmosphere.',
      {
        users: ['science', 'civil'],
        instruments: ['AIRS', 'AMSU', 'HSB', 'MODIS', 'AMSR-E/AMSR2 era', 'CERES'],
        measures: ['atmospheric temperature/humidity', 'precipitation', 'sea ice', 'radiation'],
      }
    ),
    results: R(
      'Transformed weather and climate sounding from space via AIRS and complementary sensors.',
      [
        {
          text: 'AIRS hyperspectral soundings improved weather forecast skill and climate humidity records.',
          year: 2002,
          confidence: 'published',
          source: 'NASA AIRS project / NWP impact studies',
        },
        {
          text: 'With Terra MODIS, delivered the long-running global fire and vegetation time series.',
          year: 2002,
          confidence: 'published',
          source: 'NASA MODIS',
        },
        {
          text: 'AMSR-E (and successors) mapped sea ice and soil moisture for polar and hydrology science.',
          year: 2002,
          confidence: 'published',
          source: 'JAXA/NASA AMSR',
        },
      ],
      'Atmospheric and climate data products; platform past design life but still referenced in climate records.'
    ),
  },

  'Landsat 8': {
    purpose: P(
      'Continue the Landsat record of moderate-resolution land imaging for science, resource management, and climate.',
      {
        users: ['science', 'civil', 'commercial'],
        instruments: ['OLI', 'TIRS'],
        measures: ['land cover change', 'agriculture', 'water quality', 'urban growth'],
      }
    ),
    results: R(
      'Anchor of the world’s longest continuous land-imaging archive — free and open since USGS policy change.',
      [
        {
          text: 'With Landsat 7/9, enables multi-decadal maps of deforestation, crops, glaciers, and cities at 30 m.',
          year: 2013,
          confidence: 'published',
          source: 'USGS / NASA Landsat program',
        },
        {
          text: 'Free-data policy (from Landsat 1–8 era) unlocked global applications and commercial analytics markets.',
          year: 2008,
          confidence: 'published',
          source: 'USGS Landsat free-data policy',
        },
        {
          text: 'Thermal and OLI bands support water-use, burned-area, and urban heat applications worldwide.',
          year: 2015,
          confidence: 'published',
          source: 'USGS Landsat science',
        },
      ],
      'Operational land imaging with Landsat 9; data via USGS EarthExplorer / cloud collections.'
    ),
  },

  'Landsat 9': {
    purpose: P(
      'Near-twin to Landsat 8 to keep an 8-day revisit and secure the Landsat climate data record.',
      {
        users: ['science', 'civil', 'commercial'],
        instruments: ['OLI-2', 'TIRS-2'],
        measures: ['land cover change', 'agriculture', 'surface temperature'],
      }
    ),
    results: R(
      'Secures Landsat continuity — paired with Landsat 8 for denser global land observations.',
      [
        {
          text: 'Entered service to replace aging Landsat 7 and maintain cross-calibrated continuity with Landsat 8.',
          year: 2021,
          confidence: 'published',
          source: 'NASA/USGS Landsat 9',
        },
        {
          text: 'Combined L8+L9 revisit (~8 days) improves crop, disaster, and change-detection products.',
          year: 2022,
          confidence: 'published',
          source: 'USGS Landsat program',
        },
      ],
      'Operational USGS/NASA land imaging; open data distribution.'
    ),
  },

  'ICESat-2': {
    purpose: P(
      'Measure ice-sheet and sea-ice elevation change plus vegetation canopy with photon-counting laser altimetry.',
      {
        users: ['science'],
        instruments: ['ATLAS'],
        measures: ['ice elevation', 'sea-ice freeboard', 'canopy height'],
      }
    ),
    results: R(
      'Precise laser altimetry of Earth’s ice — how fast ice sheets and sea ice are changing.',
      [
        {
          text: 'Mapped Greenland and Antarctic elevation change at high resolution, quantifying ice loss contribution to sea level.',
          year: 2020,
          confidence: 'published',
          source: 'NASA ICESat-2 science team / Nature & GRL papers',
        },
        {
          text: 'Sea-ice freeboard and thickness products improve Arctic/Antarctic ice-volume estimates.',
          year: 2019,
          confidence: 'published',
          source: 'NSIDC ICESat-2 products',
        },
        {
          text: 'Unexpected strength in vegetation and inland-water height applications.',
          year: 2021,
          confidence: 'published',
          source: 'NASA ICESat-2 applications',
        },
      ],
      'Ongoing ATLAS altimetry; products via NSIDC.'
    ),
  },

  SWOT: {
    purpose: P(
      'Survey nearly all of Earth’s surface water — oceans and inland — with wide-swath Ka-band interferometry.',
      {
        users: ['science', 'civil'],
        instruments: ['KaRIn', 'nadir altimeter', 'radiometer'],
        measures: ['sea surface height', 'river/lake levels', 'ocean mesoscale'],
      }
    ),
    results: R(
      'First global high-resolution view of ocean eddies and continental surface water from one mission.',
      [
        {
          text: 'Early KaRIn maps resolved fine-scale ocean topography previously invisible to nadir altimeters.',
          year: 2023,
          confidence: 'published',
          source: 'NASA/CNES SWOT early results',
        },
        {
          text: 'Demonstrated simultaneous lake/river stage and floodplain observations for hydrology.',
          year: 2024,
          confidence: 'published',
          source: 'SWOT Science Team / NASA Earth',
        },
      ],
      'Cal/val and science phase; hydrology and ocean products rolling out via NASA/CNES.'
    ),
  },

  'Sentinel-1A': {
    purpose: P(
      'All-weather C-band radar imaging for Copernicus — land, ice, maritime, and emergency response.',
      {
        users: ['civil', 'science', 'commercial'],
        instruments: ['C-SAR'],
        measures: ['SAR imagery', 'interferometric deformation', 'sea ice', 'ship detection'],
      }
    ),
    results: R(
      'Workhorse open SAR for disasters, ice, and ground deformation worldwide.',
      [
        {
          text: 'Rapid mapping for floods, earthquakes, and volcanoes via the Copernicus Emergency Management Service.',
          year: 2015,
          confidence: 'published',
          source: 'ESA / Copernicus EMS',
        },
        {
          text: 'Interferometry (InSAR) monitors subsidence, infrastructure, and tectonic strain at continental scale.',
          year: 2016,
          confidence: 'published',
          source: 'ESA Sentinel-1 mission results',
        },
        {
          text: 'Maritime surveillance: ice charts and ship detection independent of clouds/night.',
          year: 2015,
          confidence: 'published',
          source: 'EUMETSAT / national ice services using S-1',
        },
      ],
      'Operational Copernicus SAR (constellation status varies as A/B/C units age/replace).'
    ),
  },

  'Sentinel-2A': {
    purpose: P(
      'High-resolution multispectral optical imaging for land monitoring under Copernicus.',
      {
        users: ['civil', 'science', 'commercial'],
        instruments: ['MSI'],
        measures: ['land cover', 'agriculture', 'forestry', 'water quality'],
      }
    ),
    results: R(
      'Global 10–20 m optical workhorse — agriculture, forests, and land change at open-data scale.',
      [
        {
          text: 'With Sentinel-2B/C, ~5-day revisit enables crop monitoring and deforestation alerts worldwide.',
          year: 2017,
          confidence: 'published',
          source: 'ESA Sentinel-2 / Copernicus',
        },
        {
          text: 'Became a default input for commercial EO analytics alongside Landsat.',
          year: 2018,
          confidence: 'reported',
          source: 'Copernicus user uptake reports',
        },
      ],
      'Operational multispectral land imaging; open data via Copernicus Data Space.'
    ),
  },

  'Suomi NPP': {
    purpose: P(
      'Bridge NOAA/NASA polar orbiter for weather and climate continuity after the POES/EOS era.',
      {
        users: ['civil', 'science'],
        instruments: ['VIIRS', 'CrIS', 'ATMS', 'OMPS', 'CERES'],
        measures: ['imagery', 'soundings', 'ozone', 'radiation budget'],
      }
    ),
    results: R(
      'First JPSS-pathfinder — VIIRS night lights and operational polar weather sounding.',
      [
        {
          text: 'VIIRS day/night band created a new standard for nighttime lights and disaster power-outage mapping.',
          year: 2012,
          confidence: 'published',
          source: 'NASA/NOAA VIIRS DNB',
        },
        {
          text: 'CrIS/ATMS soundings feed global NWP models as part of the Joint Polar Satellite System backbone.',
          year: 2012,
          confidence: 'published',
          source: 'NOAA JPSS',
        },
      ],
      'Aging but historically critical polar weather/climate observations.'
    ),
  },

  'NOAA-20': {
    purpose: P(
      'Primary JPSS-1 polar satellite for operational weather forecasting and climate monitoring.',
      {
        users: ['civil', 'science'],
        instruments: ['VIIRS', 'CrIS', 'ATMS', 'OMPS'],
        measures: ['imagery', 'atmospheric soundings', 'ozone'],
      }
    ),
    results: R(
      'Operational JPSS workhorse — critical input to global weather prediction.',
      [
        {
          text: 'ATMS/CrIS data assimilated into major NWP centers, improving medium-range forecast skill.',
          year: 2018,
          confidence: 'published',
          source: 'NOAA JPSS / NWP impact assessments',
        },
        {
          text: 'VIIRS continues fire, sea-surface, and night-lights products for civil agencies.',
          year: 2018,
          confidence: 'published',
          source: 'NOAA / NASA VIIRS',
        },
      ],
      'Operational polar weather satellite in the JPSS constellation.'
    ),
  },

  'GOES-16': {
    purpose: P(
      'Geostationary weather satellite for the Americas — continuous imagery and severe-storm warning support.',
      {
        users: ['civil'],
        instruments: ['ABI', 'GLM', 'space weather suite'],
        measures: ['cloud imagery', 'lightning', 'hurricane tracking'],
      }
    ),
    results: R(
      'ABI and Geostationary Lightning Mapper remade Western Hemisphere weather monitoring.',
      [
        {
          text: 'ABI’s 16 bands and rapid scan improved hurricane, severe-storm, and fire monitoring cadence.',
          year: 2017,
          confidence: 'published',
          source: 'NOAA GOES-R program',
        },
        {
          text: 'First operational geostationary lightning mapper (GLM) for the Americas.',
          year: 2017,
          confidence: 'published',
          source: 'NOAA GLM',
        },
        {
          text: 'Core of NWS forecasting and public weather imagery for CONUS and Atlantic tropics.',
          year: 2018,
          confidence: 'published',
          source: 'NOAA/NWS',
        },
      ],
      'Operational GOES East (roles rotate with newer GOES-R series satellites).'
    ),
  },

  'GPS III': {
    purpose: P(
      'Next-generation US Global Positioning System satellites — more accurate, robust civil and military PNT.',
      {
        users: ['civil', 'military', 'commercial'],
        instruments: ['atomic clocks', 'L1C civil signal', 'M-code'],
        measures: ['position', 'navigation', 'timing'],
      }
    ),
    results: R(
      'Underpins modern timing and navigation; GPS III upgrades accuracy, authenticity, and L1C for civil users.',
      [
        {
          text: 'GPS as a system enables global aviation, logistics, telecom timing, and precision agriculture — estimated economic value in the hundreds of billions of $/year in the US alone.',
          year: 2019,
          confidence: 'reported',
          source: 'NIST / RTI GPS economic studies',
        },
        {
          text: 'GPS III adds stronger civil L1C and improved anti-jam military M-code capability as vehicles enter the constellation.',
          year: 2020,
          confidence: 'published',
          source: 'USSF / Lockheed Martin GPS III',
        },
      ],
      'Growing GPS III fraction of the operational GPS constellation (Space Force).'
    ),
  },

  Galileo: {
    purpose: P(
      'Europe’s independent global navigation satellite system for civil positioning, navigation, and timing.',
      {
        users: ['civil', 'commercial', 'military'],
        instruments: ['atomic clocks', 'E1/E5/E6 signals'],
        measures: ['position', 'navigation', 'timing', 'search-and-rescue'],
      }
    ),
    results: R(
      'Operational EU GNSS — dual-frequency civil accuracy and European PNT autonomy.',
      [
        {
          text: 'Declared Initial Services in 2016; Open Service widely used in phones and receivers alongside GPS.',
          year: 2016,
          confidence: 'published',
          source: 'EUSPA / ESA Galileo',
        },
        {
          text: 'Search-and-rescue return-link and High Accuracy Service expand beyond basic GNSS.',
          year: 2023,
          confidence: 'published',
          source: 'EUSPA Galileo services',
        },
      ],
      'Operational Galileo constellation under EU Space Programme (EUSPA).'
    ),
  },

  Starlink: {
    purpose: P(
      'Low-Earth-orbit broadband constellation to deliver internet where fiber and cellular are scarce or contested.',
      {
        users: ['commercial', 'civil', 'military'],
        measures: ['broadband throughput', 'latency', 'global coverage'],
      }
    ),
    results: R(
      'Largest satellite constellation ever — consumer and government broadband at scale.',
      [
        {
          text: 'Millions of users across 100+ countries; primary connectivity for many rural and maritime customers.',
          year: 2024,
          confidence: 'reported',
          source: 'SpaceX Starlink updates / regulatory filings',
        },
        {
          text: 'Became critical wartime and disaster connectivity (notably Ukraine and hurricane responses).',
          year: 2022,
          confidence: 'reported',
          source: 'Trade press / government statements',
        },
        {
          text: 'Drove industry and regulatory focus on mega-constellation debris, brightness, and spectrum.',
          year: 2021,
          confidence: 'published',
          source: 'FCC / IAU / NASA orbital debris discussions',
        },
      ],
      'Rapidly expanding LEO broadband; military/government variants (e.g. Starshield) alongside consumer service.'
    ),
  },

  'SBIRS GEO-1': {
    purpose: P(
      'US Space Force missile-warning satellite — detect and characterize ballistic missile launches from GEO.',
      {
        users: ['military'],
        instruments: ['scanning IR sensor', 'staring IR sensor'],
        measures: ['missile launch detection', 'infrared events'],
      }
    ),
    results: R(
      'Operational missile-warning layer; detailed performance is classified.',
      [
        {
          text: 'Part of SBIRS, which replaced DSP for US strategic missile warning and battlespace awareness.',
          year: 2011,
          confidence: 'published',
          source: 'USSF / Lockheed Martin SBIRS program',
        },
        {
          text: 'Specific detection statistics and tactical outcomes are not publicly released.',
          year: null,
          confidence: 'undisclosed',
          source: 'Classified operational reporting',
        },
      ],
      'On-orbit missile warning; being succeeded over time by Next-Gen OPIR.'
    ),
  },

  'Sentinel-6': {
    purpose: P(
      'Reference sea-level altimetry mission continuing the TOPEX/Jason climate record (Sentinel-6 Michael Freilich).',
      {
        users: ['science', 'civil'],
        instruments: ['Poseidon-4 altimeter', 'AMR-C', 'GNSS-RO'],
        measures: ['global mean sea level', 'ocean topography'],
      }
    ),
    results: R(
      'Extends the gold-standard global sea-level rise record into the 2020s.',
      [
        {
          text: 'Continues the uninterrupted altimetry climate data record begun by TOPEX/Poseidon (1992).',
          year: 2021,
          confidence: 'published',
          source: 'NASA/ESA/EUMETSAT/NOAA Sentinel-6',
        },
        {
          text: 'Provides the reference orbit for calibrating other altimeters and ocean models.',
          year: 2022,
          confidence: 'published',
          source: 'Sentinel-6 mission overview',
        },
      ],
      'Operational reference altimetry; twin Sentinel-6B planned for continuity.'
    ),
  },

  'Jason-3': {
    purpose: P(
      'Precision ocean altimeter bridging Jason-2 and Sentinel-6 for sea-level and ocean circulation.',
      {
        users: ['science', 'civil'],
        instruments: ['Poseidon-3B', 'AMR', 'DORIS', 'GPSP'],
        measures: ['sea surface height', 'wave height', 'wind speed'],
      }
    ),
    results: R(
      'Key mid-2010s link in the global sea-level rise time series.',
      [
        {
          text: 'Extended precise sea-level and mesoscale ocean topography used in climate assessments.',
          year: 2016,
          confidence: 'published',
          source: 'NOAA/EUMETSAT/CNES/NASA Jason-3',
        },
        {
          text: 'Cross-calibrated the transition toward Sentinel-6 as the new reference altimeter.',
          year: 2021,
          confidence: 'published',
          source: 'OSTST / Jason–Sentinel-6 cal/val',
        },
      ],
      'Extended mission / climate record support alongside Sentinel-6.'
    ),
  },

  SMAP: {
    purpose: P(
      'Map global soil moisture and freeze/thaw state for weather, drought, and carbon-cycle science.',
      {
        users: ['science', 'civil'],
        instruments: ['L-band radiometer', 'radar (failed 2015)'],
        measures: ['soil moisture', 'freeze/thaw'],
      }
    ),
    results: R(
      'Global L-band soil moisture — drought, flood, and NWP applications despite early radar loss.',
      [
        {
          text: 'Radiometer-only mission after radar failure still delivered validated global soil-moisture products.',
          year: 2015,
          confidence: 'published',
          source: 'NASA SMAP mission',
        },
        {
          text: 'Products used in drought monitoring, agriculture, and assimilation into land-surface / weather models.',
          year: 2017,
          confidence: 'published',
          source: 'NASA SMAP applications / NSIDC',
        },
      ],
      'Ongoing radiometer soil-moisture and freeze/thaw data.'
    ),
  },

  'GPM Core': {
    purpose: P(
      'International precipitation-measuring mission — rain and snowfall for weather, climate, and disasters.',
      {
        users: ['science', 'civil'],
        instruments: ['DPR', 'GMI'],
        measures: ['rain rate', 'snowfall', 'latent heating'],
      }
    ),
    results: R(
      'Global standard for spaceborne rain and snow measurement after TRMM.',
      [
        {
          text: 'Dual-frequency radar + microwave imager improved light rain and snowfall detection vs TRMM.',
          year: 2014,
          confidence: 'published',
          source: 'NASA/JAXA GPM',
        },
        {
          text: 'IMERG and related products used worldwide for floods, landslides, and climate precipitation datasets.',
          year: 2015,
          confidence: 'published',
          source: 'NASA GPM IMERG',
        },
      ],
      'Core observatory plus constellation partners; precipitation products via NASA PPS.'
    ),
  },

  'GRACE-FO': {
    purpose: P(
      'Track month-to-month changes in Earth’s gravity field to map water mass movement.',
      {
        users: ['science'],
        instruments: ['microwave ranging', 'laser ranging interferometer demo', 'accelerometers'],
        measures: ['groundwater', 'ice-sheet mass', 'ocean mass'],
      }
    ),
    results: R(
      'Continues the GRACE record of melting ice and shrinking groundwater from space.',
      [
        {
          text: 'With GRACE (2002–2017), revealed groundwater depletion in aquifers from California to India.',
          year: 2018,
          confidence: 'published',
          source: 'NASA/GFZ GRACE-FO / science literature',
        },
        {
          text: 'Quantifies ice-sheet and glacier mass loss contribution to sea-level rise.',
          year: 2019,
          confidence: 'published',
          source: 'NASA GRACE/GRACE-FO',
        },
        {
          text: 'Laser ranging interferometer demonstrated finer inter-satellite ranging for future gravity missions.',
          year: 2019,
          confidence: 'published',
          source: 'NASA/GFZ LRI',
        },
      ],
      'Monthly gravity-field and mass-change products via NASA/GFZ/JPL.'
    ),
  },

  'Vanguard 1': {
    purpose: P(
      'Early US naval research satellite — test launch vehicle, miniaturization, and geodesy from orbit.',
      {
        users: ['science', 'military'],
        instruments: ['radio beacons', 'temperature sensors'],
        measures: ['orbital decay', 'Earth shape'],
      }
    ),
    results: R(
      'Oldest human-made object still in orbit — and an early win for space-based geodesy.',
      [
        {
          text: 'Proved solar-powered miniaturized satellites could survive long-term in orbit (launched 1958).',
          year: 1958,
          confidence: 'published',
          source: 'NRL / NASA Vanguard history',
        },
        {
          text: 'Tracking data helped refine Earth’s shape (oblateness) and atmospheric density models.',
          year: 1959,
          confidence: 'published',
          source: 'Historical geodesy literature / NSSDCA',
        },
        {
          text: 'Remains in orbit as a derelict — a monument to the first years of the Space Age.',
          year: 2024,
          confidence: 'published',
          source: 'CelesTrak / NSSDCA',
        },
      ],
      'Inactive; tracked as debris/derelict for catalog and historical interest.'
    ),
  },
};

/** Light stubs for remaining dossiers */
const STUBS = {
  Tiangong: stub(
    'China’s crewed space station for research, technology, and continuous national human spaceflight.',
    ['science', 'civil']
  ),
  Fermi: stub('All-sky gamma-ray observatory for high-energy transients and the extragalactic background.', [
    'science',
  ]),
  'XMM-Newton': stub('ESA’s large X-ray observatory for spectroscopy of black holes, clusters, and stars.', [
    'science',
  ]),
  Swift: stub('Rapid multi-wavelength follow-up of gamma-ray bursts and other transients.', ['science']),
  NuSTAR: stub('Focusing hard X-ray telescope for black holes, supernovae, and compact objects.', ['science']),
  IXPE: stub('Measure X-ray polarization to probe magnetic fields near compact objects.', ['science']),
  'GOES-19': stub('Newest GOES-R series geostationary weather satellite for the Americas.', ['civil']),
  'Himawari-8': stub('JMA geostationary weather satellite for East Asia and the Western Pacific.', ['civil']),
  'MetOp-C': stub('EUMETSAT polar orbiter for operational meteorology and climate sounding.', ['civil']),
  'BeiDou-3': stub('China’s global navigation satellite system for PNT services.', [
    'civil',
    'military',
    'commercial',
  ]),
  GLONASS: stub('Russia’s global navigation satellite system.', ['civil', 'military']),
  QZSS: stub('Japan’s regional GNSS augmentation for the Asia-Oceania region.', ['civil', 'commercial']),
  OneWeb: stub('LEO broadband constellation (Eutelsat OneWeb) for enterprise and government connectivity.', [
    'commercial',
    'civil',
  ]),
  Iridium: stub('Global L-band voice and data constellation, including Iridium Certus broadband.', [
    'commercial',
    'civil',
    'military',
  ]),
  'Intelsat 39': stub('Geostationary communications satellite for media, mobility, and network services.', [
    'commercial',
  ]),
  'SES-17': stub('High-throughput Ka-band GEO satellite for aviation, maritime, and enterprise.', ['commercial']),
  'ViaSat-3 F1': stub('Ultra-high-capacity GEO broadband satellite for the Americas.', ['commercial']),
  'TDRS-13': stub('NASA Tracking and Data Relay Satellite for near-continuous LEO spacecraft communications.', [
    'science',
    'civil',
  ]),
  'AEHF-6': stub('US protected strategic military communications in GEO.', ['military']),
  'MUOS-5': stub('US Navy narrowband military UHF SATCOM (Mobile User Objective System).', ['military']),
  'WGS-1': stub('US high-capacity military wideband communications satellite.', ['military']),
  'Planet Doves': stub('Fleet of optical Earth-imaging CubeSats for daily global monitoring.', [
    'commercial',
    'civil',
  ]),
};

function keyOf(sat) {
  return sat.shortName || sat.name;
}

let filled = 0;
let stubbed = 0;

for (const sat of doc.satellites) {
  const k = keyOf(sat);
  const pack = SEED[k] || STUBS[k];
  if (!pack) {
    console.warn('No purpose/results for', k);
    continue;
  }
  // Drop undefined instrument/measure keys for cleaner JSON
  const purpose = { ...pack.purpose };
  if (!purpose.instruments) delete purpose.instruments;
  if (!purpose.measures) delete purpose.measures;
  sat.purpose = purpose;
  sat.results = pack.results;
  if (SEED[k]) filled++;
  else stubbed++;
}

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote purpose/results: ${filled} seeded, ${stubbed} stubbed, ${doc.satellites.length} total`);
