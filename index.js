// index.js — AU IPTV (Genre-Organized Channel Logic)
const express = require('express');
const serverless = require('serverless-http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const xml2js = require('xml2js');

// native fetch (Node 18+), fallback to node-fetch
const fetch = globalThis.fetch
  ? (...a) => globalThis.fetch(...a)
  : ((...a) => import('node-fetch').then(({ default: f }) => f(...a)));

const app = express();


// --- install counter (in-memory) with simple 24h dedupe ---
let installCount = 0;
const _lastSeen = new Map();
const DEDUPE_MS = 24 * 60 * 60 * 1000;

function markInstall(req) {
  // de-dupe by IP + request path (ignores querystring) for 24h
  const key = req.ip + '|' + req.originalUrl.split('?')[0];
  const now = Date.now();
  if (!(_lastSeen.has(key) && now - _lastSeen.get(key) < DEDUPE_MS)) {
    installCount++;
    _lastSeen.set(key, now);
  }
}



/* ------------------------- CONFIG ------------------------- */
const DEFAULT_REGION = 'Brisbane';
const REGIONS = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney'];
const CACHE_TTL = 6 * 60 * 60 * 1000;

const REGION_TZ = {
  Brisbane:  'Australia/Brisbane',
  Sydney:    'Australia/Sydney',
  Melbourne: 'Australia/Sydney',
  Hobart:    'Australia/Hobart',
  Canberra:  'Australia/Sydney',
  Adelaide:  'Australia/Adelaide',
  Darwin:    'Australia/Darwin',
  Perth:     'Australia/Perth',
};

// Traditional Australian TV channel patterns (main channels only)
const TRADITIONAL_CHANNELS = [
  // ABC Main
  ['ABC', 'ABC TV'],
  // ABC Secondary
  ['ABC NEWS', 'ABC ME', 'ABC KIDS', 'ABC TV PLUS', 'ABC iview'],
  // SBS Main
  ['SBS', 'SBS VICELAND'],
  // SBS Secondary
  ['SBS WORLD MOVIES', 'SBS FOOD', 'SBS ON DEMAND'],
  // NITV
  ['NITV'],
  // Seven
  ['Seven', '7TWO', '7MATE', '7FLIX', '7BRAVO', 'Channel 7'],
  // Nine
  ['Nine', '9GEM', '9GO', '9LIFE', '9RUSH', 'Channel 9'],
  // Ten
  ['10', '10 BOLD', '10 PEACH', '10 SHAKE', 'Channel 10', 'Network 10']
];

// These are specifically OTHER channels (not traditional)
const OTHER_CHANNELS = [
  'ABC BUSINESS', 'ABC Business in 90 Seconds', 'ABC News in 90 Seconds', 'ABC Sport in 90 Seconds', 
  'ABC Weather in 90 Seconds', 'SBS ARABIC', 'SBS CHILL', 'SBS POPASIA', 'SBS RADIO 1', 
  'SBS RADIO 2', 'SBS RADIO 3', 'SBS SOUTH ASIAN', 'SBS WORLD MOVIES', 'SBS WORLD WATCH',
  '8 OUT OF 10 CATS'
];
//AU BASE
const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const tvJsonUrl    = (region) => `${base(region)}/tv.json`;
const radioJsonUrl = (region) => `${base(region)}/radio.json`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;
const logoUrl      = (region, id) => `${base(region)}/logo/${encodeURIComponent(id)}.png`;

//NZ BASE
// --- NZ URL helpers (add) ---
const baseNZ        = () => `https://i.mjh.nz/nz`;
const tvJsonUrlNZ   = () => `${baseNZ()}/tv.json`;
const radioJsonUrlNZ= () => `${baseNZ()}/radio.json`;
const m3uUrlNZ      = () => `${baseNZ()}/raw-tv.m3u8`;
const radioM3uUrlNZ = () => `${baseNZ()}/raw-radio.m3u8`;
const epgUrlNZ      = () => `${baseNZ()}/epg.xml`;
const logoNZUrl     = (id) => `${baseNZ()}/logo/${encodeURIComponent(id)}.png`;



const cache = { m3u: new Map(), epg: new Map(), json: new Map(), radio: new Map(), radioM3u: new Map() };
const fresh = (entry) => entry && (Date.now() - entry.ts) < CACHE_TTL;
const validRegion = (r) => (REGIONS.includes(r) ? r : DEFAULT_REGION);

/* ------------------------- PARSERS ------------------------- */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = new Map();
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const name = line.split(',').pop().trim();
      const idm  = line.match(/tvg-id="([^"]+)"/);
      const logom= line.match(/tvg-logo="([^"]+)"/);
      cur = { id: idm ? idm[1] : name, name, logo: logom ? logom[1] : null };
    } else if (cur && line && !line.startsWith('#')) {
      channels.set(cur.id, { ...cur, url: line }); cur = null;
    }
  }
  return channels;
}

function normalizeTVJson(json) {
  let items;
  if (Array.isArray(json)) items = json;
  else if (Array.isArray(json?.channels)) items = json.channels;
  else if (Array.isArray(json?.streams)) items = json.streams;
  else if (json && typeof json === 'object') {
    items = Object.entries(json).map(([k, v]) => ({
      id: v?.id || v?.tvg_id || v?.guideId || v?.channel || v?.slug || k, ...v
    }));
  } else items = [];

  const channels = new Map();
  for (const it of items) {
    const id   = it.id || it.tvg_id || it.guideId || it.channel || it.slug || it.name;
    const name = it.name || it.title || it.channel || id;
    const logo = it.logo || it.tvg_logo || it.icon || null;
    const url  = it.url || (Array.isArray(it.streams) ? it.streams[0]?.url : undefined);
    if (id && name && url) channels.set(id, { id, name, logo, url });
  }
  return channels;
}

async function parseEPG(xmlText) {
  const parsed = await xml2js.parseStringPromise(xmlText, { explicitArray: true });
  const byChan = new Map();
  const progs = parsed?.tv?.programme || [];
  for (const p of progs) {
    const id = p.$?.channel;
    if (!id) continue;
    if (!byChan.has(id)) byChan.set(id, []);
    byChan.get(id).push({
      start: p.$?.start, stop: p.$?.stop,
      title: p.title?.[0]?._ || p.title?.[0] || '',
      desc:  p.desc?.[0]?._  || p.desc?.[0]  || ''
    });
  }
  return byChan;
}

/* -------------------------- FETCH ------------------------- */
async function getChannels(region, kind = 'tv') {
  const isRadio = kind === 'radio';
  const cacheKey = isRadio ? 'radio' : 'json';
  const cj = cache[cacheKey].get(region);
  if (fresh(cj)) return cj.channels;

  try {
    const jsonUrl = isRadio ? radioJsonUrl(region) : tvJsonUrl(region);
    const jRes = await fetch(jsonUrl);
    if (jRes.ok) {
      const data = await jRes.json().catch(() => null);
      const parsed = data ? normalizeTVJson(data) : new Map();
      if (parsed.size) {
        cache[cacheKey].set(region, { ts: Date.now(), channels: parsed });
        return parsed;
      }
    }
  } catch (_) {}

  // Fallback to M3U
  const m3uCacheKey = isRadio ? 'radioM3u' : 'm3u';
  const cm = cache[m3uCacheKey].get(region);
  if (fresh(cm)) return cm.channels;

  const m3uUrlToUse = isRadio ? radioM3uUrl(region) : m3uUrl(region);
  const res = await fetch(m3uUrlToUse);
  const text = await res.text();
  const channels = parseM3U(text);
  cache[m3uCacheKey].set(region, { ts: Date.now(), channels });
  return channels;
}

async function getEPG(region) {
  const c = cache.epg.get(region);
  if (fresh(c)) return c.epg;
  const res = await fetch(epgUrl(region));
  const text = await res.text();
  const epg = await parseEPG(text);
  cache.epg.set(region, { ts: Date.now(), epg });
  return epg;
}

/* ------------------------- HELPERS ------------------------ */
function parseTime(xml) {
  const m = String(xml || '').match(/(\d{4})(\d{2})(\d{2})[T ]?(\d{2})(\d{2})(\d{2})([+-]\d{4})?/);
  if (!m) return new Date(NaN);
  const [, Y, MM, DD, hh, mm, ss, off] = m;
  let offsetMin = 0;
  if (off) {
    const sign = off[0] === '-' ? -1 : 1;
    offsetMin = sign * (parseInt(off.slice(1,3),10) * 60 + parseInt(off.slice(3,5),10));
  }
  return new Date(Date.UTC(+Y, +MM-1, +DD, +hh, +mm, +ss) - offsetMin * 60000);
}

function fmtLocal(xml, tz) {
  const d = parseTime(xml);
  if (isNaN(d)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
    const h  = parts.find(p => p.type === 'hour')?.value ?? '';
    const m  = parts.find(p => p.type === 'minute')?.value ?? '';
    const ap = (parts.find(p => p.type === 'dayPeriod')?.value || '').toLowerCase();
    return `${h}:${m}${ap}`;
  } catch {
    const hh12 = d.getHours() % 12 || 12;
    const mm2 = `${d.getMinutes()}`.padStart(2,'0');
    const ap = d.getHours() >= 12 ? 'pm' : 'am';
    return `${hh12}:${mm2}${ap}`;
  }
}

function nowProgramme(list) {
  const now = Date.now();
  for (const p of list || []) {
    const s = parseTime(p.start).getTime();
    const e = parseTime(p.stop ).getTime();
    if (!Number.isNaN(s) && !Number.isNaN(e) && s <= now && now < e) return p;
  }
  return null;
}

function isRegionalChannel(name = '', region = '') {
  const s = name.toLowerCase();
  const regionalKeywords = [
    'regional','canberra','darwin','hobart','adelaide','perth','brisbane','sydney','melbourne',
    'cairns','mackay','rockhampton','townsville','toowoomba','sunshine coast','gold coast','wide bay',
    'southern cross','win','prime','imparja'
  ];
  if (s.includes(region.toLowerCase())) return false;
  return regionalKeywords.some(k => s.includes(k));
}

function isOtherChannel(channelName) {
  const name = channelName.toUpperCase();
  return OTHER_CHANNELS.some(pattern => {
    const patternUpper = pattern.toUpperCase();
    return name.includes(patternUpper) || 
           name.startsWith(patternUpper) ||
           name === patternUpper;
  });
}

function isTraditionalChannel(channelName) {
  // First check if it's explicitly an "other" channel
  if (isOtherChannel(channelName)) return false;
  
  const name = channelName.toUpperCase();
  for (const group of TRADITIONAL_CHANNELS) {
    for (const pattern of group) {
      const patternUpper = pattern.toUpperCase();
      if (name.includes(patternUpper) || 
          name.startsWith(patternUpper) ||
          name === patternUpper) {
        return true;
      }
    }
  }
  return false;
}

// --- Genre normalization helpers (add) ---
function normGenre(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function genreIs(val, ...names){
  const g = normGenre(val);
  return names.some(n => {
    const nn = normGenre(n);
    return g === nn || g.startsWith(nn);
  });
}
function genreCity(val){
  const m = normGenre(val).match(/^(.+?)\s+tv$/); // e.g. "adelaide tv"
  if (!m) return null;
  const city = m[1].split(' ').map(w => (w[0] ? w[0].toUpperCase() + w.slice(1) : '')).join(' ');
  return REGIONS.includes(city) ? city : null;
}

function getTraditionalChannelOrder(channelName) {
  const name = channelName.toUpperCase();
  for (let groupIndex = 0; groupIndex < TRADITIONAL_CHANNELS.length; groupIndex++) {
    const group = TRADITIONAL_CHANNELS[groupIndex];
    for (let patternIndex = 0; patternIndex < group.length; patternIndex++) {
      const pattern = group[patternIndex];
      const patternUpper = pattern.toUpperCase();
      if (name.includes(patternUpper) || 
          name.startsWith(patternUpper) ||
          name === patternUpper) {
        return groupIndex * 100 + patternIndex; // Group priority + pattern priority
      }
    }
  }
  return 9999; // Non-traditional channels go last
}

// --- NZ TV preferred order (add) ---
function nzKey(s) {
  if (!s) return '';
  let k = String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics (e.g., Māori)
    .toLowerCase();
  k = k.replace(/\(.*?\)/g, ' ');            // drop parentheticals
  k = k.replace(/\bchannel\s*news\s*asia\b.*?\bcna\b/, 'cna'); // simplify CNA
  k = k.replace(/\bplus\s*1\b/g, '+1');     // “Plus 1” → “+1”
  k = k.replace(/\s+/g, ' ');                 // collapse spaces
  k = k.replace(/[^a-z0-9+]+/g, ' ');          // keep only letters/digits/+ as tokens
  return k.trim();
}

const NZ_TV_ORDER = [
  'Warner Bros TV Motorheads',
  'Warner Bros TV Deadliest Catch',
  'Warner Bros TV House Hunters',
  'JuiceTV', 'The Box', 'Big Rig', 'Melo', 'The Groat',
  'TVNZ 1', 'TVNZ 2', 'Three', 'Bravo', 'Whakaata Māori', 'DUKE', 'eden',
  'Bravo PLUS 1', 'ThreePlus1', 'RUSH', 'Te Reo', 'Sky Open', 'eden+1', 'Al Jazeera', 'Sky Open+1',
  'Trackside 1', 'Trackside 2', 'Shine TV', 'Firstlight', 'Hope Channel', 'Chinese TV28', 'Chinese TV29',
  'Parliament TV', 'APNA Television', 'Panda TV', 'Wairarapa TV', 'CH200', 'Trackside Premier', 'TVSN Shopping',
  'Redbull TV', 'Channel News Asia (CNA)', 'BBC News', 'DW English'
];

const NZ_TV_INDEX = new Map(NZ_TV_ORDER.map((n, i) => [nzKey(n), i]));

function nzOrderValue(name) {
  const key = nzKey(name);
  if (NZ_TV_INDEX.has(key)) return NZ_TV_INDEX.get(key);
  // Heuristics for common aliases/variants
  if (/\bwarner\b.*\bmotorheads\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV Motorheads'));
  if (/\bwarner\b.*\bdeadliest\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV Deadliest Catch'));
  if (/\bwarner\b.*\bhouse\b.*\bhunters\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV House Hunters'));
  if (/\bbravo\b.*(?:\+1|plus\s*1)/.test(key)) return NZ_TV_INDEX.get(nzKey('Bravo PLUS 1'));
  if (/\bthree\b.*(?:\+1|plus\s*1)/.test(key)) return NZ_TV_INDEX.get(nzKey('ThreePlus1'));
  if (/\bsky\s*open\b.*\+1/.test(key)) return NZ_TV_INDEX.get(nzKey('Sky Open+1'));
  if (/^cna$/.test(key) || /\bchannel\s*news\s*asia\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Channel News Asia (CNA)'));
  if (/\bred\s*bull\b.*\btv\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Redbull TV'));
  return 10000; // unknowns go after known list
}

function logo(region, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  return logoUrl(region, ch.id);
}

// --- Poster helper that works for AU + NZ (add) ---
function logoAny(regionOrNZ, ch) {
  if (regionOrNZ === 'NZ') {
    if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
    return logoNZUrl(ch.id);
  }
  return logo(regionOrNZ, ch);
}

// --- NZ caches + fetchers (add) ---
if (!cache.nz_tv) cache.nz_tv = new Map();
if (!cache.nz_radio) cache.nz_radio = new Map();
if (!cache.nz_tv_m3u) cache.nz_tv_m3u = new Map();
if (!cache.nz_radio_m3u) cache.nz_radio_m3u = new Map();
if (!cache.nz_epg) cache.nz_epg = new Map();

async function getNZChannels(kind = 'tv') {
  const isRadio = kind === 'radio';
  const ck = isRadio ? 'nz_radio' : 'nz_tv';
  const cj = cache[ck].get('NZ');
  if (fresh(cj)) return cj.channels;

  try {
    const jsonUrl = isRadio ? radioJsonUrlNZ() : tvJsonUrlNZ();
    const jRes = await fetch(jsonUrl);
    if (jRes.ok) {
      const data = await jRes.json().catch(() => null);
      const parsed = data ? normalizeTVJson(data) : new Map();
      if (parsed.size) {
        cache[ck].set('NZ', { ts: Date.now(), channels: parsed });
        return parsed;
      }
    }
  } catch(_) {}

  const m3uKey = isRadio ? 'nz_radio_m3u' : 'nz_tv_m3u';
  const cm = cache[m3uKey].get('NZ');
  if (fresh(cm)) return cm.channels;

  const url = isRadio ? radioM3uUrlNZ() : m3uUrlNZ();
  const text = await (await fetch(url)).text();
  const channels = parseM3U(text);
  cache[m3uKey].set('NZ', { ts: Date.now(), channels });
  return channels;
}

async function getNZEPG() {
  const c = cache.nz_epg.get('NZ');
  if (fresh(c)) return c.epg;
  try {
    const res = await fetch(epgUrlNZ());
    if (res.ok) {
      const text = await res.text();
      const epg = await parseEPG(text);
      cache.nz_epg.set('NZ', { ts: Date.now(), epg });
      return epg;
    }
  } catch(_) {}
  const empty = new Map();
  cache.nz_epg.set('NZ', { ts: Date.now(), epg: empty });
  return empty;
}


/* ------------------------- MANIFEST ----------------------- */
function buildManifest(selectedRegion, includeRadio) {
  const catalogs = [];
  
  // Generate genre options for third dropdown
  const genreOptions = [
    'Traditional Channels',  // Main TV channels (default)
    'Other Channels',        // Non-traditional channels
    'All TV Channels',       // Combined traditional + other
    'Regional Channels'      // Regional/local channels
  ];
  
  if (includeRadio) {
    genreOptions.push('Radio');
  }
  
  // Add other cities to genre options
  const otherCities = REGIONS.filter(r => r !== selectedRegion);
  otherCities.forEach(city => {
    genreOptions.push(`${city} TV`);
  });
  
  // Main TV catalog with genre filtering
  catalogs.push({
    type: 'tv',
    id: `au_tv_${selectedRegion}`,
    name: `AU TV - ${selectedRegion}`,
    extra: [
      { name: 'search' },
      { 
        name: 'genre', 
        options: genreOptions,
        isRequired: false 
      }
    ]
  });

  return {
    id: 'com.joshargh.auiptv',
    version: '1.5.0',
    name: `AU IPTV (${selectedRegion})`,
    description: `Australian live TV and Radio - Main city: ${selectedRegion}. Use Genre filter to access other content types and cities.`,
    types: ['tv'],
    catalogs,
    resources: ['catalog','meta','stream'],
  };
}


// --- v2 manifest builder (add NZ) ---
function buildManifestV2(selectedRegion, includeRadio, includeNZ, nzDefault) {
  const catalogs = [];

  // Base genre options (same as v1)
  const genreOptions = [
    'Traditional Channels',
    'Other Channels',
    'All TV Channels',
    'Regional Channels',
  ];

  if (includeRadio) genreOptions.push('Radio');

  // Add other AU cities
  const otherCities = REGIONS.filter(r => r !== selectedRegion);
  otherCities.forEach(city => genreOptions.push(`${city} TV`));

  // NZ options (only if enabled)
  if (includeNZ) {
    genreOptions.push('NZ TV', 'NZ Radio');
    // If NZ is default, put NZ TV first
    if (nzDefault) {
      const nzTV = 'NZ TV';
      const nzRadio = 'NZ Radio';
      // Move NZ TV to the very front, keep others in order
      const pruned = genreOptions.filter(g => g !== nzTV && g !== nzRadio);
      genreOptions.length = 0;
      genreOptions.push(nzTV, ...pruned); // NZ TV first
    }
  }

  const displayName = nzDefault ? 'NZ' : selectedRegion;

  catalogs.push({
    type: 'tv',
    id: `au_tv_${selectedRegion}`, // keep id stable; name shows "AU TV - NZ" if nzDefault
    name: `AU TV - ${displayName}`,
    extra: [
      { name: 'search' },
      {
        name: 'genre',
        options: genreOptions,
        // When NZ is set as default, make genre required.
        // Stremio then hides "None" and defaults to the first option (NZ TV).
        isRequired: !!nzDefault
      }
    ]
  });


  return {
    id: 'com.joshargh.auiptv',
    version: '2.0.0',
    name: `AU IPTV (${displayName})`,
    description: includeNZ
      ? `Australian + NZ live streams. Main city: ${selectedRegion}. Use Genre for NZ / cities / radio.`
      : `Australian live TV and Radio - Main city: ${selectedRegion}. Use Genre filter to access other content types and cities.`,
    types: ['tv'],
    catalogs,
    resources: ['catalog','meta','stream'],
  };
}



/* ---------------------- ADDON BUILDER --------------------- */
const builder = new addonBuilder(buildManifest(DEFAULT_REGION, true));

function parseCatalogId(id) {
  // For the new structure, we only have one main catalog per region
  const m = id.match(/^au_tv_([^_]+)$/);
  if (m) {
    const region = validRegion(m[1]);
    return { kind: 'tv', region };
  }
  
  // fallback
  return { kind: 'tv', region: DEFAULT_REGION };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== 'tv') return { metas: [] };
  const { region } = parseCatalogId(id);

  const selectedGenreRaw = extra?.genre || 'Traditional Channels';
  const selectedGenre = String(selectedGenreRaw);

  // Decide what to show
  let contentRegion = region;   // AU city by default
  let contentKind   = 'tv';
  let catalogType   = 'traditional';
  let isNZ          = false;

  if (genreIs(selectedGenre, 'traditional channels', 'traditional')) {
    catalogType = 'traditional';
  } else if (genreIs(selectedGenre, 'other channels', 'other')) {
    catalogType = 'other';
  } else if (genreIs(selectedGenre, 'all tv channels', 'all tv', 'all')) {
    catalogType = 'all';
  } else if (genreIs(selectedGenre, 'regional channels', 'regional')) {
    catalogType = 'regional';
  } else if (genreIs(selectedGenre, 'radio')) {
    contentKind = 'radio';
  } else if (genreIs(selectedGenre, 'nz tv', 'nz')) {
    isNZ = true;
    contentKind = 'tv';
    catalogType = 'all'; // show all NZ TV
  } else if (genreIs(selectedGenre, 'nz radio')) {
    isNZ = true;
    contentKind = 'radio';
  } else {
    // e.g. "adelaide tv" / "hobart tv" etc. (handles dots, dashes, spaces)
    const cityName = genreCity(selectedGenre);
    if (cityName) {
      contentRegion = cityName;
      catalogType = 'all';
    }
  }

  const tz = isNZ ? 'Pacific/Auckland' : (REGION_TZ[contentRegion] || 'Australia/Sydney');
  const channels = isNZ ? await getNZChannels(contentKind) : await getChannels(contentRegion, contentKind);
  const epg = (contentKind === 'tv') ? (isNZ ? await getNZEPG() : await getEPG(contentRegion)) : new Map();

  const metas = [];

  for (const [cid, ch] of channels) {
    if (contentKind === 'tv') {
      // AU filtering only; NZ just "all"
      let includeChannel = true;

      if (!isNZ) {
        const isTraditional = isTraditionalChannel(ch.name);
        const isOther = isOtherChannel(ch.name);
        const isRegional = isRegionalChannel(ch.name, contentRegion);

        switch (catalogType) {
          case 'traditional': includeChannel = isTraditional && !isRegional; break;
          case 'other':       includeChannel = (isOther || (!isTraditional && !isRegional)) && !isRegional; break;
          case 'all':         includeChannel = !isRegional; break;
          case 'regional':    includeChannel = isRegional; break;
          default:            includeChannel = true;
        }
      }

      if (!includeChannel) continue;
      if ((extra?.search || '').toLowerCase() && !ch.name.toLowerCase().includes((extra?.search || '').toLowerCase())) continue;

      const list = epg.get(cid) || [];
      const nowp = nowProgramme(list);
      const release = nowp
        ? `${fmtLocal(nowp.start, tz)} | ${nowp.title}`
        : (list[0] ? `${fmtLocal(list[0].start, tz)} | ${list[0].title}` : (isNZ ? 'Live NZ TV' : 'Live TV'));
      const desc = list.slice(0,4).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');

      metas.push({
        id: `${isNZ ? 'au|NZ' : `au|${contentRegion}`}|${cid}|tv`,
        type: 'tv',
        name: ch.name,
        poster: logoAny(isNZ ? 'NZ' : contentRegion, ch),
        releaseInfo: release,
        description: desc || (isNZ ? 'Live NZ television' : 'Live television streaming'),
        _sortOrder: isNZ ? 9999 : (isTraditionalChannel(ch.name) ? getTraditionalChannelOrder(ch.name) : 9999)
      });

    } else {
      // Radio
      if ((extra?.search || '').toLowerCase() && !ch.name.toLowerCase().includes((extra?.search || '').toLowerCase())) continue;
      metas.push({
        id: `${isNZ ? 'au|NZ' : `au|${contentRegion}`}|${cid}|radio`,
        type: 'tv',
        name: ch.name,
        poster: logoAny(isNZ ? 'NZ' : contentRegion, ch),
        releaseInfo: isNZ ? 'Live NZ Radio' : 'Live Radio',
        description: isNZ ? 'Live NZ radio streaming' : 'Live radio streaming',
        _sortOrder: 9999
      });
    }
  }

  // Sort
  if (isNZ && contentKind === 'tv') {
    metas.sort((a, b) => {
      const ai = nzOrderValue(a.name);
      const bi = nzOrderValue(b.name);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  } else if (!isNZ && (catalogType === 'traditional' || catalogType === 'all')) {
    metas.sort((a, b) => {
      if (a._sortOrder !== b._sortOrder) return a._sortOrder - b._sortOrder;
      return a.name.localeCompare(b.name);
    });
  } else {
    metas.sort((a, b) => a.name.localeCompare(b.name));
  }

  metas.forEach(m => delete m._sortOrder);
  return { metas };
});


function parseItemId(id) {
  const p = String(id||'').split('|');
  if (p.length < 3 || p[0] !== 'au') return null;
  const [, regionRaw, cid, kindRaw = 'tv'] = p;
  const region = (regionRaw === 'NZ') ? 'NZ' : validRegion(regionRaw);
  const kind = (kindRaw === 'radio' ? 'radio' : 'tv');
  return { region, cid, kind };
}


builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: {} };
  const parsed = parseItemId(id);
  if (!parsed) return { meta: {} };
  const { region, cid, kind } = parsed;

  const tz = region === 'NZ' ? 'Pacific/Auckland' : (REGION_TZ[region] || 'Australia/Sydney');
  const channels = (region === 'NZ') ? await getNZChannels(kind) : await getChannels(region, kind);
  const ch = channels.get(cid);
  if (!ch) return { meta: {} };

  if (kind === 'tv') {
    const progs = (region === 'NZ') ? (await getNZEPG()).get(cid) || [] : (await getEPG(region)).get(cid) || [];
    const desc = progs.slice(0,8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
    const nowp = nowProgramme(progs);

    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: logoAny(region, ch),
        description: desc || (region === 'NZ' ? 'Live NZ television' : 'Live television streaming'),
        releaseInfo: nowp ? `${fmtLocal(nowp.start, tz)} - ${fmtLocal(nowp.stop, tz)} | ${nowp.title}` : (region === 'NZ' ? 'Live NZ TV' : 'Live TV'),
      }
    };
  } else {
    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: logoAny(region, ch),
        description: region === 'NZ' ? 'Live NZ radio streaming' : 'Live radio streaming',
        releaseInfo: region === 'NZ' ? 'Live NZ Radio' : 'Live Radio',
      }
    };
  }
});


builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv') return { streams: [] };
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const { region, cid, kind } = parsed;

  const channels = (region === 'NZ') ? await getNZChannels(kind) : await getChannels(region, kind);
  const ch = channels.get(cid);
  if (!ch) return { streams: [] };
  return { streams: [{ url: ch.url, title: 'Play' }] };
});


/* ----------------------- LANDING PAGE --------------------- */
const CONFIG_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AU IPTV v2</title><meta http-equiv="Cache-Control" content="no-store"/>
<style>
:root{color-scheme:dark;--bg:#0b0c0f;--card:#14161a;--muted:#9aa4b2;--text:#ecf2ff;--ok:#34c759;--okText:#04210d;--line:#22252b;--accent:#4fc3f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
.wrap{display:grid;place-items:center;padding:28px}.card{width:min(880px,92vw);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{margin:0 0 6px;font-size:26px;display:flex;align-items:center;gap:8px}
.badge{display:inline-block;line-height:1;padding:4px 8px;border-radius:999px;background:var(--accent);color:#001219;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}
.lead{margin:0 0 14px;color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
label{font-size:13px;color:var(--muted)}select{background:#0f1115;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:#101318;color:var(--text);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{background:#0e1218}.btn-primary{background:var(--ok);border-color:var(--ok);color:var(--okText);font-weight:700}
.btn-ghost{background:transparent}
code{display:block;margin-top:10px;padding:10px 12px;background:#0f1115;border:1px solid var(--line);border-radius:10px;color:#a7f3d0;overflow:auto;word-break:break-all;font-size:12px}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.catalogs{margin:16px 0;padding:12px;background:#0f1115;border:1px solid var(--line);border-radius:10px}
.catalogs h3{margin:0 0 8px;font-size:14px;color:var(--text)}
.catalogs ul{margin:0;padding-left:18px;font-size:13px;color:var(--muted)}
.catalogs li{margin:2px 0}
.catalogs strong{color:var(--text)}
.announce{background:#101a26;border:1px solid #113049;border-radius:10px;padding:12px;margin:14px 0}
.announce h4{margin:0 0 6px;color:var(--accent);font-size:14px}
.announce ul{margin:0;padding-left:18px;font-size:13px;color:var(--muted)}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.cta-note{font-size:12px;color:var(--muted)}
.stats{justify-content:flex-start;font-size:13px;color:#c0d0ff}
.stat-pill{border:1px solid var(--line);border-radius:999px;padding:6px 10px;background:#0f1115}
.spacer{ flex:1 }                  /* pushes installs to the right in the h1 */
.h1-installs{
  font-size:12px; line-height:1;
  border:1px solid var(--line);
  border-radius:999px; padding:4px 10px;
  background:#0f1115; color:var(--muted);
}

</style></head><body>
<div class="wrap"><div class="card">
<h1>
  AU IPTV <span class="badge">v2</span>
  <span class="spacer"></span>
  <span id="installs" class="h1-installs" aria-live="polite" title="Total installs">Installs: —</span>
</h1>
  <p class="lead">AU + NZ live TV & radio for Stremio. Pick your main city, then install. Use the <b>Genre</b> dropdown in Stremio to switch to NZ, Radio, or other AU cities.</p>

  <div class="announce">
    <h4>🚀 What’s new in v2</h4>
    <ul>
      <li>🇳🇿 NZ TV & Radio (optional) + curated NZ channel order</li>
      <li>🧠 “Set NZ as default” hides the “None” genre and shows NZ first</li>
      <li>📺 Cleaner AU channel grouping (Traditional / Other / Regional)</li>
    </ul>
  </div>

  <hr>
  <div class="row">
    <label for="region">Main City</label>
    <select id="region">
      <option>Adelaide</option><option selected>Brisbane</option><option>Canberra</option><option>Darwin</option>
      <option>Hobart</option><option>Melbourne</option><option>Perth</option><option>Sydney</option>
      <option value="" disabled>—</option>
      <option>New Zealand</option>
    </select>
  </div>
  <div class="row">
    <label><input type="checkbox" id="radio" checked> Include Radio</label>
  </div>
  <div class="row" id="nzRow">
    <label style="margin-left:12px"><input type="checkbox" id="nz"> Include NZ TV</label>
    <label style="margin-left:12px; display:none" id="nzDefaultWrap"><input type="checkbox" id="nzDefault"> Set NZ as default</label>
  </div>

  <div class="catalogs">
    <h3>Available via Genre:</h3>
    <ul>
      <li><strong>Traditional Channels</strong> — ABC, SBS, NITV, Seven, Nine, Ten</li>
      <li><strong>Other Channels</strong> — ABC Business, SBS specialty etc</li>
      <li><strong>All TV Channels</strong> — Traditional + Other</li>
      <li><strong>Regional Channels</strong> — local/regional feeds</li>
      <li><strong>Radio</strong> — if enabled</li>
      <li><strong>[City] TV</strong> — other AU cities</li>
      <li><strong>NZ TV / NZ Radio</strong> — when NZ is enabled</li>
    </ul>
  </div>

  <div class="row">
    <button id="open" class="btn btn-primary">Open in Stremio Web</button>
    <a id="manifestLink" class="btn btn-ghost" href="#" target="_blank" rel="noopener">Open manifest.json</a>
  </div>


  <code id="preview">—</code>
  <div class="hint">Web installer: <span id="weburl">—</span></div>
</div>
  <div class="cta">
    <a class="btn btn-primary" href="https://hook.up.me/joshargh" target="_blank" rel="noopener noreferrer">☕ Get $10 free coffee (on me)</a>
    <a class="btn" href="http://paypal.me/joshargh" target="_blank" rel="noopener noreferrer">💸 Help with server costs (PayPal)</a>
  </div>
  <div class="cta-note">Instead of “buy me a coffee”, let me buy <i>you</i> one — sign up via Hook for $10 free. If you’d still like to chip in, PayPal helps keep the addon running.</div>
</div>



<script>
const $ = s => document.querySelector(s);

// AU city list + helpers
const AU_CITIES = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney'];
let lastAuCity = 'Brisbane';
function isAuCity(v){ return AU_CITIES.includes(v); }
function setRegion(val){
  const sel = document.querySelector('#region');
  for (const opt of sel.options){
    if (opt.text === val){ sel.value = val; return true; }
  }
  return false;
}

// Never emit "New Zealand" as :region in the URL (backend expects AU city there)
function region() {
  const raw = ($('#region').value || 'Brisbane').trim();
  const auRegion = (raw === 'New Zealand') ? lastAuCity : raw;
  return encodeURIComponent(auRegion);
}

function pathPrefix() {
  const parts = [region()];
  if ($('#radio').checked) parts.push('radio');
  if ($('#nz').checked) {
    parts.push('nz');
    if ($('#nzDefault').checked) parts.push('nzdefault');
  }
  return '/' + parts.join('/');
}

function manifestUrl() { return location.origin + pathPrefix() + '/manifest.json'; }
function webInstall(u) { return 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(u); }

function update() {
  // show/hide "NZ default" checkbox
  $('#nzDefaultWrap').style.display = $('#nz').checked ? 'inline-block' : 'none';
  if (!$('#nz').checked) $('#nzDefault').checked = false;

  const m = manifestUrl();
  const w = webInstall(m);
  $('#preview').textContent = m;
  $('#weburl').textContent = w;
  $('#manifestLink').href = m;
}

// remember last AU city
$('#region').addEventListener('change', () => {
  const v = $('#region').value;
  if (isAuCity(v)) lastAuCity = v;
  update();
});

// toggles
$('#nz').addEventListener('change', update);
$('#radio').addEventListener('change', update);

// Don't force-select "New Zealand" in the dropdown; just ensure NZ is enabled
$('#nzDefault').addEventListener('change', () => {
  if ($('#nzDefault').checked && !$('#nz').checked) {
    $('#nz').checked = true;
  }
  update();
});

// Copy helper
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

// Buttons: copy URL first, then open
$('#open').addEventListener('click', async () => {
  update();
  const m = manifestUrl();
  await copyToClipboard(m);
  window.open(webInstall(m), '_blank', 'noopener,noreferrer');
});

$('#manifestLink').addEventListener('click', async (e) => {
  e.preventDefault();
  update();
  const m = manifestUrl();
  await copyToClipboard(m);
  window.open(m, '_blank', 'noopener,noreferrer');
});

// installs ticker
setInterval(refreshStats, 5000);
refreshStats();

// initial render
update();
document.addEventListener('DOMContentLoaded', () => { update(); refreshStats(); });

async function refreshStats(){
  try{
    const r = await fetch('/stats', { cache: 'no-store' });
    const j = await r.json();
    const n = (j.installs ?? 0);
    const fmt = new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 });
    const el = document.querySelector('#installs');
    el.textContent = 'Installs: ' + fmt.format(n);
    el.setAttribute('aria-label', n.toLocaleString() + ' total installs');
  } catch(_) {}
}
</script>

</body></html>`;


/* ----------------------- EXPRESS ROUTES ------------------- */
//installstats


// CORS & no-store
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

/* ----------------------- EXPRESS ROUTES ------------------- */
// CORS & no-store
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

// Stats endpoint (for the landing page installs ticker)
app.get('/stats', (_req, res) => res.json({ installs: installCount }));

// Health
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Landing page
app.get('/', (_req, res) => res.type('html').send(CONFIG_HTML));


// Dynamic manifest routes

// --- v2 manifest responder + route (add) ---
function manifestResponderV2(req, res) {
  try {
    // Parse flags from the path (works across Express 4/5)
    // Examples supported:
    // /Brisbane/manifest.json
    // /Brisbane/radio/manifest.json
    // /Brisbane/nz/manifest.json
    // /Brisbane/radio/nz/manifest.json
    // /Brisbane/radio/nz/nzdefault/manifest.json
    const m = req.path.match(/^\/([^/]+)/);
    const regionRaw = decodeURIComponent(m ? m[1] : DEFAULT_REGION);
    const region = validRegion(regionRaw);

    const includeRadio = /\/radio(\/|$)/.test(req.path);
    const includeNZ    = /\/nz(\/|$)/.test(req.path);
    const nzDefault    = /\/nzdefault(\/|$)/.test(req.path);
    
    markInstall(req);

    res.json(buildManifestV2(region, includeRadio, includeNZ, nzDefault));
  } catch (e) {
    console.error('manifest v2 error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}

// Supports /:region/manifest.json
//          /:region/radio/manifest.json
//          /:region/nz/manifest.json
//          /:region/radio/nz/manifest.json
//          /:region/radio/nz/nzdefault/manifest.json
// Robust matcher that works across Express 4/5 (captures first segment as region)
app.get(/^\/[^/]+(?:\/radio)?(?:\/nz)?(?:\/nzdefault)?\/manifest\.json$/, manifestResponderV2);

function manifestResponder(req, res) {
  try {
    const region = validRegion(req.params.region);
    const includeRadio = /\/radio(\/|$)/.test(req.path);
    res.json(buildManifest(region, includeRadio));
    markInstall(req);

  } catch (e) {
    console.error('manifest error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}


app.get('/:region/manifest.json', manifestResponder);
app.get('/:region/radio/manifest.json', manifestResponder);

// Fallback: plain /manifest.json -> default region, radio ON
app.get('/manifest.json', (req, res) => {
  markInstall(req); // count installs when this URL is used
  res.json(buildManifest(DEFAULT_REGION, true));
});


/*
 * IMPORTANT: Stremio will request /PREFIX/catalog|meta|stream/...
 * We strip any leading /<region>[/radio] prefix before handing off
 * to the SDK router, so paths like /Brisbane/radio/catalog/... still work.
 */
const sdkRouter = getRouter(builder.getInterface());
app.use((req, res, next) => {
  const targets = ['/catalog/','/meta/','/stream/'];
  let idx = -1;
  for (const t of targets) {
    const i = req.url.indexOf(t);
    if (i >= 0) idx = (idx === -1 ? i : Math.min(idx, i));
  }
  if (idx > 0) req.url = req.url.slice(idx); // strip prefix before passing to SDK
  next();
});
app.use('/', sdkRouter);

// Serverless export
module.exports.handler = serverless(app);

// For local dev:
// if (require.main === module) {
//   const PORT = process.env.PORT || 7000;
//   app.listen(PORT, () => console.log('Listening on', PORT));
// }