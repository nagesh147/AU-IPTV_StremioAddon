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

/* ------------------------- CONFIG ------------------------- */
const DEFAULT_REGION = 'Brisbane';
const REGIONS = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney'];
const REGION_TZ = {
  Adelaide: 'Australia/Adelaide', Brisbane: 'Australia/Brisbane', Canberra: 'Australia/Sydney',
  Darwin: 'Australia/Darwin', Hobart: 'Australia/Hobart', Melbourne: 'Australia/Melbourne',
  Perth: 'Australia/Perth', Sydney: 'Australia/Sydney'
};

/* cache */
const CACHE_TTL = 15 * 60 * 1000; // 15 min
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

function parseEPG(xml) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, (err, res) => {
      if (err) return reject(err);
      const map = new Map();
      const progs = res?.tv?.programme || [];
      for (const p of progs) {
        const cid = p.$?.channel || '';
        theStart = p.$?.start || '';
        theStop  = p.$?.stop  || '';
        const title = (Array.isArray(p.title) ? p.title[0] : p.title) || '';
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push({ start: theStart, stop: theStop, title });
      }
      resolve(map);
    });
  });
}

function parseTime(s) {
  // supports EPG "YYYYMMDDHHmmss Z" or ISO; fallback to Date(s)
  if (/^\d{14}\s+[+\-]\d{4}$/.test(s)) {
    const y=+s.slice(0,4), mo=+s.slice(4,6)-1, d=+s.slice(6,8), h=+s.slice(8,10), m=+s.slice(10,12), sec=+s.slice(12,14);
    const off = s.slice(15); // like +1000
    const sign = off[0] === '-' ? -1 : 1;
    const offMin = sign * (parseInt(off.slice(1,3))*60 + parseInt(off.slice(3,5)));
    return new Date(Date.UTC(y,mo,d,h,m,sec) - offMin*60000);
  }
  const d = new Date(s);
  return isNaN(d) ? new Date() : d;
}

const fmtLocal = (s, tz) => {
  const d = parseTime(s);
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
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

/* ----------------- AU classification + order --------------- */
function isOtherChannel(channelName) {
  const name = channelName.toUpperCase();
  const OTHER_CHANNELS = [
    'ABC BUSINESS','ABC BUSINESS IN 90 SECONDS','ABC NEWS IN 90 SECONDS','ABC SPORT IN 90 SECONDS',
    'ABC WEATHER IN 90 SECONDS',
    'SBS ARABIC','SBS CHILL','SBS POPASIA','SBS RADIO 1','SBS RADIO 2','SBS RADIO 3',
    'SBS SOUTH ASIAN','SBS WORLD MOVIES','SBS WORLD WATCH','SBS WORLDWATCH','SBS FOOD','SBS VICELAND',
    '8 OUT OF 10 CATS'
  ];
  return OTHER_CHANNELS.includes(name);
}

const TRADITIONAL_CHANNELS = [
  ['ABC TV','ABC','ABC NEWS','ABC ME','ABC KIDS','ABC TV PLUS','ABC ENTERTAINS','ABC FAMILY'],
  ['SBS','NITV'],
  ['SEVEN','7TWO','7MATE','7FLIX','7BRAVO','CHANNEL 7','NETWORK 7'],
  ['NINE','9GEM','9GO','9GO!','9LIFE','9RUSH','CHANNEL 9'],
  ['TEN','10','10 BOLD','10 PEACH','10 SHAKE','10 COMEDY','10 DRAMA','CHANNEL 10','NETWORK 10']
];

function isTraditionalChannel(name='') {
  const u = name.toUpperCase();
  for (const group of TRADITIONAL_CHANNELS) {
    if (group.some(g => u.includes(g))) return true;
  }
  return false;
}

const AU_TRAD_ORDER = [
  'ABC ENTERTAINS','ABC FAMILY','ABC KIDS','ABC NEWS','ABC TV',
  'SBS','NITV',
  'SEVEN','7TWO','7MATE','7FLIX','7BRAVO',
  '9GEM','9GO!','9GO','9LIFE','9RUSH','CHANNEL 9','NINE',
  '10','10 BOLD','10 PEACH','10 SHAKE','10 COMEDY','10 DRAMA','CHANNEL 10','NETWORK 10'
];
const AU_TRAD_INDEX = new Map(AU_TRAD_ORDER.map((n,i)=>[n,i]));
function auTradOrderValue(name='') {
  const u = name.toUpperCase();
  for (const key of AU_TRAD_ORDER) {
    if (u.includes(key)) return AU_TRAD_INDEX.get(key);
  }
  return 10000;
}

//AU BASE
const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const tvJsonUrl    = (region) => `${base(region)}/tv.json`;
const radioJsonUrl = (region) => `${base(region)}/radio.json`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;
const logoUrl      = (region, id) => `${base(region)}/logo/${encodeURIComponent(id)}.png`;

//NZ BASE
const baseNZ        = () => `https://i.mjh.nz/nz`;
const tvJsonUrlNZ   = () => `${baseNZ()}/tv.json`;
const radioJsonUrlNZ= () => `${baseNZ()}/radio.json`;
const m3uUrlNZ      = () => `${baseNZ()}/raw-tv.m3u8`;
const radioM3uUrlNZ = () => `${baseNZ()}/raw-radio.m3u8`;
const epgUrlNZ      = () => `${baseNZ()}/epg.xml`;
const logoNZUrl     = (id) => `${baseNZ()}/logo/${encodeURIComponent(id)}.png`;

/* --------------------- UK Sports (no UHD) ------------------ */
// UK Sports-only playlist (no Sky branding in HTML; channel names come from source)
const UK_SPORTS_URL = 'https://forgejo.plainrock127.xyz/Mystique-Play/Mystique/raw/branch/main/countries/uk_sports.m3u';

// Stronger UHD detector (name or URL)
function isUHD(name = '', url = '') {
  const n = String(name);
  const u = String(url);
  return /\b(UHD|4K|2160p?)\b/i.test(n) || /\b(HEVC|H\.?265|Main10)\b/i.test(n) ||
         /(2160|uhd|4k|hevc|main10|h\.?265)/i.test(u);
}

// Parse ALL entries (don’t collapse duplicates yet)
function parseM3UEntries(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let meta = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const name  = line.split(',').pop().trim();
      const idm   = line.match(/tvg-id="([^"]+)"/i);
      const logom = line.match(/tvg-logo="([^"]+)"/i);
      meta = { id: idm ? idm[1] : name, name, logo: logom ? logom[1] : null };
    } else if (meta && line && !line.startsWith('#')) {
      out.push({ ...meta, url: line.trim() }); meta = null;
    }
  }
  return out;
}

// Normalize for grouping: drop quality tags & provider prefixes (keep "Sky" in name)
function baseNameUK(name = '') {
  return String(name)
    .replace(/^\s*(UKI?\s*\|\s*)/i, '')                 // "UK |", "UKI |"
    .replace(/\b(UHD|4K|2160p?|FHD|1080p|HD|720p|SD)\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Prefer non-UHD (FHD→HD→SD→unknown). Never keep UHD.
async function getUKAllChannels() {
  if (fresh(cache.uk_all)) return cache.uk_all.channels;

  const res = await fetch(UK_SPORTS_URL, { cache: 'no-store' });
  const text = await res.text();
  const entries = parseM3UEntries(text);

  const bestByBase = new Map();
  const score = (name = '', url = '') => {
    if (isUHD(name, url)) return -1; // reject UHD completely
    const n = name.toLowerCase(), u = url.toLowerCase();
    if (/fhd|1080/.test(n) || /1080/.test(u)) return 30;
    if (/\bhd\b|720/.test(n) || /720/.test(u)) return 20;
    if (/sd|576|480/.test(n) || /(576|480)/.test(u)) return 10;
    return 15; // unknown quality – usually fine
  };

  for (const e of entries) {
    const base = baseNameUK(e.name);
    const s = score(e.name, e.url);
    if (s < 0) continue; // UHD tossed
    const prev = bestByBase.get(base);
    if (!prev || s > prev._score) {
      // Keep display name but strip explicit quality tags like "UHD/FHD/HD"
      const displayName = e.name.replace(/\b(UHD|4K|2160p?|FHD|1080p|HD|720p|SD)\b/ig, '').replace(/\s{2,}/g,' ').trim();
      bestByBase.set(base, { ...e, name: displayName, _score: s });
    }
  }

  // Emit as a Map compatible with the rest of the addon
  const channels = new Map();
  for (const [base, e] of bestByBase) {
    const key = e.id || base; // stable key
    channels.set(key, { id: key, name: e.name, logo: e.logo, url: e.url });
  }

  cache.uk_all = { ts: Date.now(), channels };
  return channels;
}


/* ------------------------- FETCHERS ----------------------- */
async function getChannels(region, kind = 'tv') {
  if (kind === 'radio') {
    const key = `${region}:radio_m3u`;
    const c = cache.radioM3u.get(key);
    if (c && fresh(c)) return c.channels;

    let channels = new Map();
    try {
      const text = await (await fetch(radioM3uUrl(region))).text();   // AU radio for the selected city
      channels = parseM3U(text);
    } catch (_) {}

    if (!channels || channels.size === 0) {
      try {
        const j = await (await fetch(radioJsonUrl(region))).json();   // AU radio JSON fallback
        channels = normalizeTVJson(j);
      } catch (_) {}
    }

    cache.radioM3u.set(key, { ts: Date.now(), channels });
    return channels;
  }

  const key = `${region}:m3u`;
  const c = cache.m3u.get(key);
  if (c && fresh(c)) return c.channels;

  const text = await (await fetch(m3uUrl(region))).text();
  const channels = parseM3U(text);

  cache.m3u.set(key, { ts: Date.now(), channels });
  return channels;
}


async function getEPG(region) {
  const key = `${region}:epg`;
  const c = cache.epg.get(key);
  if (c && fresh(c)) return c.map;
  const xml = await (await fetch(epgUrl(region))).text();
  const map = await parseEPG(xml);
  cache.epg.set(key, { ts: Date.now(), map });
  return map;
}

// --- NZ caches + fetchers ---
if (!cache.nz_tv) cache.nz_tv = new Map();
if (!cache.nz_radio) cache.nz_radio = new Map();
if (!cache.nz_tv_m3u) cache.nz_tv_m3u = new Map();
if (!cache.nz_radio_m3u) cache.nz_radio_m3u = new Map();
if (!cache.nz_epg) cache.nz_epg = new Map();

async function getNZChannels(kind='tv') {
  if (kind === 'radio') {
    const c = cache.nz_radio_m3u.get('nz');
    if (c && fresh(c)) return c.channels;
    const text = await (await fetch(radioM3uUrlNZ())).text();
    const channels = parseM3U(text);
    cache.nz_radio_m3u.set('nz', { ts: Date.now(), channels });
    return channels;
  }
  const c = cache.nz_tv_m3u.get('nz');
  if (c && fresh(c)) return c.channels;
  const text = await (await fetch(m3uUrlNZ())).text();
  const channels = parseM3U(text);
  cache.nz_tv_m3u.set('nz', { ts: Date.now(), channels });
  return channels;
}

async function getNZEPG() {
  const c = cache.nz_epg.get('nz');
  if (c && fresh(c)) return c.map;
  const xml = await (await fetch(epgUrlNZ())).text();
  const map = await parseEPG(xml);
  cache.nz_epg.set('nz', { ts: Date.now(), map });
  return map;
}

/* ----------------------- ORDERING (NZ) -------------------- */
const NZ_TV_ORDER = [
  'Warner Bros TV Motorheads','Warner Bros TV Deadliest Catch','Warner Bros TV House Hunters','JuiceTV','The Box','Big Rig','Melo','The Groat',
  'TVNZ 1','TVNZ 2','Three','Bravo','Whakaata Māori','DUKE','eden','Bravo PLUS 1','ThreePlus1','RUSH','Te Reo','Sky Open','eden+1','Al Jazeera','Sky Open+1',
  'Trackside 1','Trackside 2','Shine TV','Firstlight','Hope Channel','Chinese TV28','Chinese TV29','Parliament TV','APNA Television','Panda TV','Wairarapa TV','CH200','Trackside Premier','TVSN Shopping','Redbull TV','Channel News Asia (CNA)','BBC News','DW English'
];
const nzKey = (s) => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const NZ_TV_INDEX = new Map(NZ_TV_ORDER.map((n,i)=>[nzKey(n),i]));
function nzOrderValue(name) {
  const key = nzKey(name);
  if (NZ_TV_INDEX.has(key)) return NZ_TV_INDEX.get(key);
  if (/\bwarner\b.*\bmotorheads\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV Motorheads'));
  if (/\bwarner\b.*\bdeadliest\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV Deadliest Catch'));
  if (/\bwarner\b.*\bhouse\b.*\bhunters\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Warner Bros TV House Hunters'));
  if (/\bbravo\b.*(?:\+1|plus\s*1)/.test(key)) return NZ_TV_INDEX.get(nzKey('Bravo PLUS 1'));
  if (/\bthree\b.*(?:\+1|plus\s*1)/.test(key)) return NZ_TV_INDEX.get(nzKey('ThreePlus1'));
  if (/\bsky\s*open\b.*\+1/.test(key)) return NZ_TV_INDEX.get(nzKey('Sky Open+1'));
  if (/^cna$/.test(key) || /\bchannel\s*news\s*asia\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Channel News Asia (CNA)'));
  if (/\bred\s*bull\b.*\btv\b/.test(key)) return NZ_TV_INDEX.get(nzKey('Redbull TV'));
  return 10000;
}

function logo(region, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  return logoUrl(region, ch.id);
}
function logoAny(regionOrNZ, ch) {
  if (regionOrNZ === 'NZ') {
    if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
    return logoNZUrl(ch.id);
  }
  if (regionOrNZ === 'UK') {
    if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
    return ch.logo || '';
  }
  return logo(regionOrNZ, ch);
}

/* ---------------------- MANIFEST v1 ----------------------- */
function genreCity(selected) {
  const s = String(selected||'').toLowerCase().replace(/[^a-z0-9+ ]+/gi,' ').trim();
  const m = s.match(/^(adelaide|brisbane|canberra|darwin|hobart|melbourne|perth|sydney)\s*tv$/);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : null;
}
function genreIs(selected, ...opts) {
  const s = String(selected||'').toLowerCase().replace(/\s+/g,' ').trim();
  return opts.some(o => s === String(o).toLowerCase());
}

function buildManifest(selectedRegion, includeRadio) {
  const catalogs = [];
  const genreOptions = ['Traditional Channels','Other Channels','All TV Channels','Regional Channels'];
  if (includeRadio) genreOptions.push('Radio');
  const otherCities = REGIONS.filter(r => r !== selectedRegion);
  otherCities.forEach(city => genreOptions.push(`${city} TV`));

  catalogs.push({
    type: 'tv',
    id: `au_tv_${selectedRegion}`,
    name: `AU TV - ${selectedRegion}`,
    extra: [
      { name: 'search' },
      { name: 'genre', options: genreOptions, isRequired: false }
    ]
  });

  return {
    id: 'com.joshargh.auiptv',
    version: '1.5.0',
    name: `AU IPTV (${selectedRegion})`,
    description: `Australian live TV and Radio - Main city: ${selectedRegion}. Use Genre filter to access other content types and cities.`,
    types: ['tv'], catalogs, resources: ['catalog','meta','stream']
  };
}

// --- v2 manifest builder (AU + NZ + UK Sports) ---
function buildManifestV2(selectedRegion, includeRadio, includeNZ, nzDefault, includeUKSports=false) {
  const catalogs = [];

  const genreOptions = [
    'Traditional Channels',
    'Other Channels',
    'All TV Channels',
    'Regional Channels',
  ];
  if (includeRadio) genreOptions.push('Radio');

  const otherCities = REGIONS.filter(r => r !== selectedRegion);
  otherCities.forEach(city => genreOptions.push(`${city} TV`));

  if (includeNZ) {
    genreOptions.push('NZ TV', 'NZ Radio');
    if (nzDefault) {
      const nzTV = 'NZ TV';
      const nzRadio = 'NZ Radio';
      const pruned = genreOptions.filter(g => g !== nzTV && g !== nzRadio);
      genreOptions.length = 0;
      genreOptions.push(nzTV, ...pruned, nzRadio);
    }
  }

  if (includeUKSports) genreOptions.push('UK Sports');

  const displayName = nzDefault ? 'NZ' : selectedRegion;
  catalogs.push({
    type: 'tv', id: `au_tv_${selectedRegion}`, name: `AU IPTV - ${displayName}`,
    extra: [ { name: 'search' }, { name: 'genre', options: genreOptions, isRequired: !!nzDefault } ]
  });

  return {
    id: 'com.joshargh.auiptv',
    version: '2.3.0',
    name: `AU IPTV (${displayName})`,
    description: includeNZ
      ? `Australian + NZ live streams with optional UK Sports. Main city: ${selectedRegion}.`
      : `Australian live TV and Radio with optional UK Sports. Main city: ${selectedRegion}.`,
    types: ['tv'], catalogs, resources: ['catalog','meta','stream']
  };
}

/* ---------------------- ADDON BUILDER --------------------- */
const builder = new addonBuilder(buildManifest(DEFAULT_REGION, true));

function parseCatalogId(id) {
  const m = id.match(/^au_tv_([^_]+)$/);
  if (m) { const region = validRegion(m[1]); return { kind: 'tv', region }; }
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
  let isUKSports    = false;

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
    isNZ = true; contentKind = 'tv'; catalogType = 'all';
  } else if (genreIs(selectedGenre, 'nz radio')) {
    isNZ = true; contentKind = 'radio';
  } else if (genreIs(selectedGenre, 'uk sports', 'uk sport')) {
    contentKind = 'tv'; isUKSports = true; catalogType = 'all';
  } else {
    const cityName = genreCity(selectedGenre);
    if (cityName) { contentRegion = cityName; catalogType = 'all'; }
  }

  const tz = isNZ ? 'Pacific/Auckland' : (isUKSports ? 'Europe/London' : (REGION_TZ[contentRegion] || 'Australia/Sydney'));
  let channels;
  if (isNZ) channels = await getNZChannels(contentKind);
  else if (isUKSports) channels = await getUKAllChannels();
  else channels = await getChannels(contentRegion, contentKind);

  const epg = (contentKind === 'tv') ? (isNZ ? await getNZEPG() : new Map()) : new Map();

  const metas = [];
  for (const [cid, ch] of channels) {
    if (contentKind === 'tv') {
      let includeChannel = true;
      let sortVal;
      if (!isNZ && !isUKSports) {
        const traditional = isTraditionalChannel(ch.name);
        const other = isOtherChannel(ch.name);
        const regional = isRegionalChannel(ch.name, contentRegion);

        if (catalogType === 'traditional') {
          includeChannel = traditional && !regional && !other;
          if (includeChannel) sortVal = auTradOrderValue(ch.name);
        } else if (catalogType === 'other') {
          includeChannel = (other || (!traditional && !regional)) && !regional;
        } else if (catalogType === 'regional') {
          includeChannel = regional;
        } else {
          includeChannel = !regional;
        }
      }
      if (!includeChannel) continue;

      const list = epg.get(cid) || [];
      const nowp = nowProgramme(list);
      const release = nowp ? `${fmtLocal(nowp.start, tz)} | ${nowp.title}`
                           : (list[0] ? `${fmtLocal(list[0].start, tz)} | ${list[0].title}`
                           : (isNZ ? 'Live NZ TV' : (isUKSports ? 'Live UK' : 'Live TV')));

      metas.push({
        id: `au|${isNZ?'NZ':(isUKSports?'UK':contentRegion)}|${cid}|${contentKind}`,
        type: 'tv',
        name: ch.name,
        poster: logoAny(isNZ?'NZ':(isUKSports?'UK':contentRegion), ch),
        description: isNZ ? 'New Zealand TV' : (isUKSports ? 'UK Sports' : (catalogType === 'regional' ? 'Regional AU TV' : 'Live AU TV')),
        releaseInfo: release,
        _sortOrder: isNZ ? nzOrderValue(ch.name)
                         : (catalogType === 'traditional' ? (sortVal ?? 10000)
                         : (catalogType === 'regional' ? 0 : undefined))
      });
    } else {
      metas.push({
        id: `au|${isNZ?'NZ':contentRegion}|${cid}|radio`,
        type: 'tv',
        name: ch.name,
        poster: logoAny(isNZ?'NZ':contentRegion, ch),
        description: isNZ ? 'New Zealand Radio' : 'Live AU Radio',
        releaseInfo: isNZ ? 'Live NZ Radio' : 'Live Radio'
      });
    }
  }

  if (isNZ) {
    metas.sort((a, b) => (a._sortOrder - b._sortOrder) || a.name.localeCompare(b.name));
  } else if (!isUKSports && catalogType === 'traditional') {
    metas.sort((a, b) => (a._sortOrder - b._sortOrder) || a.name.localeCompare(b.name));
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
  const region = (regionRaw === 'NZ') ? 'NZ' : (regionRaw === 'UK' ? 'UK' : validRegion(regionRaw));
  const kind = (kindRaw === 'radio' ? 'radio' : 'tv');
  return { region, cid, kind };
}


builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: {} };
  const parsed = parseItemId(id);
  if (!parsed) return { meta: {} };
  const { region, cid, kind } = parsed;

  const tz = region === 'NZ' ? 'Pacific/Auckland' : (region === 'UK' ? 'Europe/London' : (REGION_TZ[region] || 'Australia/Sydney'));
  let channels; if (region === 'NZ') channels = await getNZChannels(kind); else if (region === 'UK') channels = await getUKAllChannels(); else channels = await getChannels(region, kind);
  const ch = channels.get(cid);
  if (!ch) return { meta: {} };

  if (kind === 'tv') {
    const progs = (region === 'NZ') ? (await getNZEPG()).get(cid) || [] : (region === 'UK' ? [] : (await getEPG(region)).get(cid) || []);
    const desc = progs.slice(0,8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
    const nowp = nowProgramme(progs);

    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: logoAny(region, ch),
        description: desc || (region === 'NZ' ? 'Live NZ television' : (region === 'UK' ? 'UK Sports' : 'Live television streaming')),
        releaseInfo: nowp ? `${fmtLocal(nowp.start, tz)} - ${fmtLocal(nowp.stop, tz)} | ${nowp.title}` : (region === 'NZ' ? 'Live NZ TV' : (region === 'UK' ? 'Live UK TV' : 'Live TV')),
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

  let channels; if (region === 'NZ') channels = await getNZChannels(kind); else if (region === 'UK') channels = await getUKAllChannels(); else channels = await getChannels(region, kind);
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
.spacer{ flex:1 }
.h1-installs{font-size:12px;line-height:1;border:1px solid var(--line);border-radius:999px;padding:4px 10px;background:#0f1115;color:var(--muted)}
details.acc{background:#0f1115;border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}
details.acc>summary{cursor:pointer;padding:10px 12px;font-weight:700;color:var(--text);list-style:none}
details.acc[open]>summary{border-bottom:1px solid var(--line)}
.acc-body{padding:10px 12px}
</style></head><body>
<div class="wrap"><div class="card">
<h1>
  AU IPTV <span class="badge">v2</span>
  <span class="spacer"></span>
  <span id="installs" class="h1-installs" aria-live="polite" title="Total installs">Installs: —</span>
</h1>
  <p class="lead">AU + NZ live TV & radio for Stremio. Pick your main city, then install. Use the <b>Genre</b> dropdown in Stremio to switch to NZ, Radio, other AU cities, or UK Sports.</p>

  <div class="announce">
    <h4>🚀 What’s new in v2.3</h4>
    <ul>
      <li>🏟️ UK Sports pack (optional) - UK & Sky Sports HD channels</li>
      <li>📺 NZ TV & Radio (optional) + curated NZ channel order</li>
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

  <details class="acc" id="nzAcc">
    <summary>NZ Additional Streams</summary>
    <div class="acc-body">
      <div class="row" id="nzRow">
        <label style="margin-left:12px"><input type="checkbox" id="nz"> Include NZ TV</label>
        <label style="margin-left:12px; display:none" id="nzDefaultWrap"><input type="checkbox" id="nzDefault"> Set NZ as default</label>
      </div>
    </div>
  </details>

  <details class="acc" id="ukAcc">
    <summary>UK Sports (optional)</summary>
    <div class="acc-body">
      <div class="row" id="ukRow">
        <label style="margin-left:12px"><input type="checkbox" id="ukSports"> UK Sports</label>
      </div>
    </div>
  </details>

  <div class="catalogs">
    <h3>Available via Genre:</h3>
    <ul>
      <li><strong>Traditional Channels</strong> — ABC, SBS (core), NITV, Seven, Nine, Ten</li>
      <li><strong>Other Channels</strong> — SBS specialty, ABC shorts, and everything else non-regional</li>
      <li><strong>All TV Channels</strong> — Traditional + Other</li>
      <li><strong>Regional Channels</strong> — local/regional feeds</li>
      <li><strong>Radio</strong> — if enabled</li>
      <li><strong>[City] TV</strong> — other AU cities</li>
      <li><strong>NZ TV / NZ Radio</strong> — when NZ is enabled</li>
      <li><strong>UK Sports</strong> — when enabled</li>
    </ul>
  </div>

  <div class="row">
    <button id="open" class="btn btn-primary">Open in Stremio Web</button>
    <a id="manifestLink" class="btn btn-ghost" href="#" target="_blank" rel="noopener">Open manifest.json</a>
    <button id="copy" class="btn">Copy manifest URL</button>
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
  if ($('#ukSports')?.checked) parts.push('uksports');
  return '/' + parts.join('/');
}

function manifestUrl() { return location.origin + pathPrefix() + '/manifest.json'; }
function webInstall(u) { return 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(u); }

function update() {
  $('#nzDefaultWrap').style.display = $('#nz').checked ? 'inline-block' : 'none';
  if (!$('#nz').checked) $('#nzDefault').checked = false;

  const m = manifestUrl();
  const w = webInstall(m);
  $('#preview').textContent = m;
  $('#weburl').textContent = w;
  $('#manifestLink').href = m;
}

$('#region').addEventListener('change', () => {
  const v = $('#region').value;
  if (isAuCity(v)) lastAuCity = v;
  update();
});

$('#nz').addEventListener('change', update);
$('#radio').addEventListener('change', update);
$('#ukSports').addEventListener('change', update);

$('#nzDefault').addEventListener('change', () => {
  if ($('#nzDefault').checked && !$('#nz').checked) {
    $('#nz').checked = true;
  }
  update();
});

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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

$('#copy').addEventListener('click', async () => {
  update();
  const m = manifestUrl();
  await copyToClipboard(m);
  const btn = document.getElementById('copy');
  const t = btn.textContent; btn.textContent = 'Copied!';
  setTimeout(()=>btn.textContent=t, 1200);
});

let installsTimer = null;
function startStats(){
  if (installsTimer) return;
  installsTimer = setInterval(refreshStats, 5000);
}
async function refreshStats(){
  try{
    const r = await fetch('/stats', { cache: 'no-store' });
    const j = await r.json();
    const n = (j.installs ?? 0);
    const fmt = new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 });
    const el = document.querySelector('#installs');
    el.textContent = 'Installs: ' + fmt.format(n);
    el.setAttribute('aria-label', (n||0).toLocaleString() + ' total installs');
  } catch(_) {}
}

update();
startStats();
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) refreshStats(); });
</script>

</body></html>`;

/* ----------------------- EXPRESS ROUTES ------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/', (_req, res) => res.type('html').send(CONFIG_HTML));

function manifestResponderV2(req, res) {
  try {
    const m = req.path.match(/^\/([^/]+)/);
    const regionRaw = decodeURIComponent(m ? m[1] : DEFAULT_REGION);
    const region = validRegion(regionRaw);

    const includeRadio = /\/radio(\/|$)/.test(req.path);
    const includeNZ    = /\/nz(\/|$)/.test(req.path);
    const nzDefault    = /\/nzdefault(\/|$)/.test(req.path);
    // Accept legacy /ukskysports and /ukskyother but treat both as UK Sports
    const includeUKSports = /\/uksports(\/|$)|\/ukskysports(\/|$)|\/ukskyother(\/|$)/.test(req.path);

    res.json(buildManifestV2(region, includeRadio, includeNZ, nzDefault, includeUKSports));
  } catch (e) {
    console.error('manifest v2 error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}

// Accepts /:region[/radio][/nz][/nzdefault][/uksports]/manifest.json
// (legacy: also allows /ukskysports and /ukskyother but both map to Sports)
app.get(/^\/[^/]+(?:\/radio)?(?:\/nz)?(?:\/nzdefault)?(?:\/uksports|\/ukskysports|\/ukskyother)?(?:\/ukcustom\/[^/]+)?\/manifest\.json$/, manifestResponderV2);

function manifestResponder(req, res) {
  try {
    const region = validRegion(req.params.region);
    const includeRadio = /\/radio(\/|$)/.test(req.path);
    res.json(buildManifest(region, includeRadio));
  } catch (e) {
    console.error('manifest error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}

app.get('/:region/manifest.json', manifestResponder);
app.get('/:region/radio/manifest.json', manifestResponder);

app.get('/manifest.json', (_req, res) => res.json(buildManifest(DEFAULT_REGION, true)));

const sdkRouter = getRouter(builder.getInterface());
app.use((req, res, next) => {
  const targets = ['/catalog/','/meta/','/stream/'];
  let idx = -1;
  for (const t of targets) {
    const i = req.url.indexOf(t);
    if (i >= 0) idx = (idx === -1 ? i : Math.min(idx, i));
  }
  if (idx > 0) req.url = req.url.slice(idx);
  next();
});
app.use('/', sdkRouter);

//Online Enable Addon
//module.exports.handler = serverless(app);

//DEBUG LOCAL TESTING
// Uncomment the following lines to run the server locally for testing
if (require.main === module) {
  const PORT = process.env.PORT || 7000;
  app.listen(PORT, () => console.log('Listening on', PORT));
}
