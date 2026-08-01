#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'profile-link-check.json');
const UA = 'OverheadSatCatalog/1.0 (+https://github.com/goldsteinmarcmd/overhead; link check)';
const TIMEOUT_MS = 20000;
const CONCURRENCY = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function addLink(links, url, occurrence) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const normalized = url.trim();
  if (!links.has(normalized)) {
    links.set(normalized, {
      url: normalized,
      occurrences: [],
    });
  }
  links.get(normalized).occurrences.push(occurrence);
}

function collectLinks() {
  const enrichment = readJson('data/enrichment.json');
  const satmeta = readJson('data/satmeta.json');
  const links = new Map();

  for (const [norad, sat] of Object.entries(enrichment.byNorad || {})) {
    for (const narrative of sat.narratives || []) {
      addLink(links, narrative.url, {
        norad: Number(norad),
        satellite: sat.name || null,
        field: 'enrichment.narratives.url',
        provider: narrative.provider || null,
        label: narrative.label || null,
      });
    }
  }

  for (const [norad, sat] of Object.entries(satmeta.byNorad || {})) {
    if (sat.satnogs?.website) {
      addLink(links, sat.satnogs.website, {
        norad: Number(norad),
        satellite: sat.objectName || null,
        field: 'satmeta.satnogs.website',
        provider: 'satnogs',
        label: 'Website',
      });
    }
    if (sat.ceos?.url) {
      addLink(links, sat.ceos.url, {
        norad: Number(norad),
        satellite: sat.objectName || sat.ceos.name || null,
        field: 'satmeta.ceos.url',
        provider: 'ceos',
        label: sat.ceos.name || 'CEOS MIM',
      });
    }
  }

  return links;
}

async function probe(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: method === 'HEAD' ? '*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...(method === 'GET' ? { Range: 'bytes=0-4095' } : {}),
      },
    });
    return {
      method,
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url || url,
      ok: res.status >= 200 && res.status < 400,
    };
  } catch (err) {
    return {
      method,
      status: null,
      statusText: null,
      finalUrl: url,
      ok: false,
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUrl(url) {
  const head = await probe(url, 'HEAD');
  if (head.ok) return head;

  let get = await probe(url, 'GET');
  if (get.status === 429) {
    await sleep(5000);
    get = await probe(url, 'GET');
  }
  if (get.ok) return { ...get, headStatus: head.status, headError: head.error };
  return { ...get, headStatus: head.status, headError: head.error };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      if ((i + 1) % 100 === 0) {
        process.stderr.write(`checked ${i + 1}/${items.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const links = collectLinks();
  const urls = [...links.keys()].sort();
  process.stderr.write(`checking ${urls.length} unique profile links\n`);

  const checked = await mapLimit(urls, CONCURRENCY, async (url) => {
    const result = await checkUrl(url);
    return {
      url,
      works: result.ok,
      status: result.status,
      statusText: result.statusText,
      method: result.method,
      finalUrl: result.finalUrl,
      error: result.error || null,
      headStatus: result.headStatus ?? null,
      occurrenceCount: links.get(url).occurrences.length,
      occurrences: links.get(url).occurrences,
    };
  });

  const working = checked.filter((item) => item.works);
  const broken = checked.filter((item) => !item.works);
  const report = {
    generated: new Date().toISOString(),
    checkedScope: [
      'Satellite profile narrative links from data/enrichment.json',
      'Satellite profile SatNOGS website links from data/satmeta.json',
      'Satellite profile CEOS mission links from data/satmeta.json',
    ],
    summary: {
      uniqueLinks: checked.length,
      working: working.length,
      broken: broken.length,
      occurrences: checked.reduce((sum, item) => sum + item.occurrenceCount, 0),
    },
    working,
    broken,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${path.relative(ROOT, OUT)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
