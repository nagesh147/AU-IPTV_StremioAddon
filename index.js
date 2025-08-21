// index.js — AU IPTV (AU+NZ with selectable US/UK/CA TV & Sports) — v2.6.3 Curated + Multi-Quality Streams
const express = require('express');
const serverless = require('serverless-http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const xml2js = require('xml2js');
const path = require('path');

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

// --- stremio-addons.net signature (optional) ---
const STREMIO_ADDONS_CONFIG = {
  issuer: 'https://stremio-addons.net',
  signature: process.env.STREMIO_ADDONS_SIGNATURE
    || 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..jPqqSM-s0k525D13Y_oqXA.Hz3vTlruk-WxtkneysiM4Eq9sAuCSNcW_77QHAdRFocIAbom2Ju8lhwpSI0W8aEtMeqefAV4i46N7Z5452wqPfJZZHzJ9OVcDtDTqaGxi33Znt68CD8oZqQOalnRrC2x.qR2mVkk9v112anUUgUoFCQ'
};

// --- Posters: use map.json → GitHub /images for ALL TV & Radio (grid), tvg-logo for detail/title ---
const IMAGES_BASE = process.env.IMAGES_BASE || 'https://raw.githubusercontent.com/josharghhh/AU-IPTV_StremioAddon/main';
let POSTER_MAP = {};
try { POSTER_MAP = require('./map.json'); } catch (_) { POSTER_MAP = {}; }

// square poster from /images (GitHub) if mapped; otherwise fall back
function posterFromMapAbs(chId) {
  const rel = POSTER_MAP?.[chId];
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  const p = rel.startsWith('/images/') ? rel : `/images/${String(rel).replace(/^\/+/, '')}`;
  return `${IMAGES_BASE}${p}`;
}
function posterAny(regionOrKey, ch) {
  const mapped = posterFromMapAbs(ch.id);
  if (mapped) return mapped;                 // prefer your square art
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  if (regionOrKey === 'NZ') return `${baseNZ()}/logo/${encodeURIComponent(ch.id)}.png`;
  if (String(regionOrKey || '').startsWith('SP')) return ''; // curated may not have a fallback
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}
// tvg-logo (as provided in M3U) for the meta detail header (title area)
function m3uLogoAny(regionOrKey, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo; // tvg-logo
  if (regionOrKey === 'NZ') return `${baseNZ()}/logo/${encodeURIComponent(ch.id)}.png`;
  if (String(regionOrKey || '').startsWith('SP')) return '';
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}

// Seedable, in-memory installs counter
const STATS_SEED = Number(process.env.STATS_SEED || 498);
let _memStats = { installs: STATS_SEED };

/* cache */
const CACHE_TTL = 15 * 60 * 1000; // 15 min
const cache = {
  m3u: new Map(), epg: new Map(), json: new Map(),
  radio: new Map(), radioM3u: new Map(),
  a1x: new Map(),
  nz_tv: new Map(), nz_radio: new Map(), nz_tv_m3u: new Map(), nz_radio_m3u: new Map(), nz_epg: new Map()
};
const fresh = (entry) => entry && (Date.now() - entry.ts) < CACHE_TTL;
const validRegion = (r) => (REGIONS.includes(r) ? r : DEFAULT_REGION);

// Simple in-memory install bump (no S3, no dedupe)
function markInstall(_req) {
  _memStats.installs = (_memStats.installs || 0) + 1;
}

/* ------------------------- PARSERS ------------------------- */
function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = new Map();
  let cur = null;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name = line.split(',').pop().trim();
      const idm   = line.match(/tvg-id="([^"]+)"/i);
      theLogo     = line.match(/tvg-logo="([^"]+)"/i);
      const logom = theLogo;
      const grp   = line.match(/group-title="([^"]+)"/i);
      cur = { id: idm ? idm[1] : name, name, logo: logom ? logom[1] : null, group: grp ? grp[1] : null };
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur) cur.group = line.slice(8).trim();
    } else if (cur && !line.startsWith('#')) {
      channels.set(cur.id, { ...cur, url: line }); cur = null;
    }
  }
  return channels;
}

function parseM3UEntries(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let meta = null;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name  = line.split(',').pop().trim();
      const idm   = line.match(/tvg-id="([^"]+)"/i);
      const logom = line.match(/tvg-logo="([^"]+)"/i);
      const grp   = line.match(/group-title="([^"]+)"/i);
      meta = { id: idm ? idm[1] : name, name, logo: logom ? logom[1] : null, group: grp ? grp[1] : null };
    } else if (line.startsWith('#EXTGRP:')) {
      if (meta) meta.group = line.slice(8).trim();
    } else if (meta && !line.startsWith('#')) {
      out.push({ ...meta, url: line }); meta = null;
    }
  }
  return out;
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
        const theStart = p.$?.start || '';
        const theStop  = p.$?.stop  || '';
        const title = (Array.isArray(p.title) ? p.title[0] : p.title) || '';
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push({ start: theStart, stop: theStop, title });
      }
      resolve(map);
    });
  });
}

function parseTime(s) {
  if (/^\d{14}\s+[+\-]\d{4}$/.test(s)) {
    const y=+s.slice(0,4), mo=+s.slice(4,6)-1, d=+s.slice(6,8), h=+s.slice(8,10), m=+s.slice(10,12), sec=+s.slice(12,14);
    const off = s.slice(15);
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
function isOtherChannel(channelName = '') {
  const u = String(channelName).toUpperCase();
  const normalized = u.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const OTHER_CHANNELS = [
    'ABC BUSINESS','ABC BUSINESS IN 90 SECONDS','ABC NEWS IN 90 SECONDS','ABC SPORT IN 90 SECONDS',
    'ABC WEATHER IN 90 SECONDS',
    'SBS ARABIC','SBS CHILL','SBS POPASIA','SBS RADIO 1','SBS RADIO 2','SBS RADIO 3',
    'SBS SOUTH ASIAN','SBS WORLD MOVIES','SBS WORLD WATCH','SBS WORLDWATCH','SBS FOOD','SBS VICELAND',
    '8 OUT OF 10 CATS'
  ];
  if (OTHER_CHANNELS.includes(u)) return true;

  if (/\bHAVE YOU BEEN PAYING ATTENTION\b/.test(normalized)) return true;
  if (/\bHYBPA\b/.test(normalized)) return true;

  if (/(?:\b8\b|\bEIGHT\b)\s*(?:OUT\s*OF\s*)?\b10\b\s*CATS(?:\s*DOES\s*COUNTDOWN)?\b/.test(normalized)) {
    return true;
  }

  return false;
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

// AU BASE
const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const tvJsonUrl    = (region) => `${base(region)}/tv.json`;
const radioJsonUrl = (region) => `${base(region)}/radio.json`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;
const logoUrl      = (region, id) => `${base(region)}/logo/${encodeURIComponent(id)}.png`;

// NZ BASE
const baseNZ        = () => `https://i.mjh.nz/nz`;
const m3uUrlNZ      = () => `${baseNZ()}/raw-tv.m3u8`;
const radioM3uUrlNZ = () => `${baseNZ()}/raw-radio.m3u8`;
const epgUrlNZ      = () => `${baseNZ()}/epg.xml`;
const logoNZUrl     = (id) => `${baseNZ()}/logo/${encodeURIComponent(id)}.png`;

/* --------------------- Curated (primary) ------------------ */
/* Hide provider branding in UI — we just call these “Curated” */
const A1X_CURATED_PRIMARY = 'https://bit.ly/a1xstream';
const A1X_CURATED_BACKUP  = 'https://a1xs.vip/a1xstream';
const A1X_CURATED_DIRECT  = 'https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u';


const A1X_EPG_URL = 'https://bit.ly/a1xepg';
/* -------------- UK Sports tertiary fallback (legacy) ---------- */
const UK_SPORTS_FALLBACK = 'https://forgejo.plainrock127.xyz/Mystique-Play/Mystique/raw/branch/main/countries/uk_sports.m3u';

/* ---------- Quality helpers (for curated multi-variant) --------- */
function norm(s='') { return String(s||'').toLowerCase(); }
function isUHD(name = '', url = '') {
  const n = norm(name), u = norm(url);
  return /\b(uhd|4k|2160p?)\b/.test(n) || /(2160|uhd|4k|hevc|main10|h\.?265)/.test(u);
}
function isFHD(name = '', url = '') {
  const s = norm(name + ' ' + url);
  return /\b(fhd|1080p?)\b/.test(s) || /(?:^|[^0-9])1080(?:[^0-9]|$)/.test(s);
}
function isHD(name = '', url = '') {
  const s = norm(name + ' ' + url);
  return /\bhd\b/.test(s) || /\b720p?\b/.test(s) || /(?:^|[^0-9])720(?:[^0-9]|$)/.test(s);
}
function qualityLabel(name = '', url = '') {
  if (isUHD(name, url)) return 'UHD / 4K';
  if (isFHD(name, url)) return 'FHD / 1080p';
  if (isHD(name, url))  return 'HD / 720p';
  return 'SD';
}
function qualityRank(label = '') {
  const l = label.toUpperCase();
  if (l.includes('UHD')) return 3;
  if (l.includes('FHD')) return 2;
  if (l.includes('HD'))  return 1;
  return 0;
}
function baseNameClean(name = '') {
  return String(name)
    .replace(/^\s*(?:UKI?\s*\|\s*|\[[^\]]+\]\s*)/i, '')
    .replace(/\b(UHD|4K|2160p?|FHD|1080p|HD|720p|SD)\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Curated group matchers */
const tvMatcher = (...labels) =>
  new RegExp(`^\\s*(?:${labels.join('|')})\\s*(?:TV\\s*Channels?|Channels?|TV\\s*Channel)\\s*$`, 'i');
const sportsMatcher = (...labels) =>
  new RegExp(`^\\s*(?:${labels.join('|')})\\s*Sports?(?:\\s*Channels?)?\\s*$`, 'i');

const A1X_GROUPS = {
  // sports
  epl:              /^EPL$/i,
  uk_sports:        sportsMatcher('UK','United\\s*Kingdom'),
  us_sports:        sportsMatcher('US','USA','United\\s*States'),
  ca_sports:        sportsMatcher('CA','Canada'),
  au_sports:        sportsMatcher('AU','Australia'),
  nz_sports:        sportsMatcher('NZ','New\\s*Zealand'),
  eu_sports:        sportsMatcher('EU','Europe','European'),
  world_sports:     sportsMatcher('World','International'),

  // tv (non-sports)
  uk_tv:            tvMatcher('UK','United\\s*Kingdom'),
  us_tv:            tvMatcher('US','USA','United\\s*States'),
  ca_tv:            tvMatcher('CA','Canada'),
};

async function fetchCuratedM3U() {
  const c = cache.a1x.get('curated_text');
  if (c && fresh(c)) return c.text;

  const headers = { 'User-Agent': 'Mozilla/5.0 (AUIPTV-Addon)' };
  let text = '';

  try {
    const r1 = await fetch(A1X_CURATED_PRIMARY, { redirect: 'follow', headers });
    text = await r1.text();
  } catch (_) {}

  if (!text || text.length < 100) {
    try {
      const r2 = await fetch(A1X_CURATED_BACKUP, { redirect: 'follow', headers });
      text = await r2.text();
    } catch (_) {}
  }

  if (!text || text.length < 100) {
    try {
      const r3 = await fetch(A1X_CURATED_DIRECT, { redirect: 'follow', headers });
      text = await r3.text();
    } catch (_) {}
  }

  cache.a1x.set('curated_text', { ts: Date.now(), text: String(text || '') });
  return String(text || '');
}

async function fetchCuratedEntries() {
  const c = cache.a1x.get('curated_entries');
  if (c && fresh(c)) return c.entries;
  const text = await fetchCuratedM3U();
  const entries = parseM3UEntries(text);
  cache.a1x.set('curated_entries', { ts: Date.now(), entries });
  return entries;
}

/**
 * Returns a Map(baseId -> { id, name, logo, url (default best), variants: [{label,url,rank}] })
 * Variants include HD/FHD/UHD when present. Default url is the highest-ranked reliable variant (UHD>FHD>HD>SD).
 */
async function getCuratedGroup(key) {
  const ck = `group:${key}:v2`;
  const c = cache.a1x.get(ck);
  if (c && fresh(c)) return c.channels;

  const matcher = A1X_GROUPS[key];
  let channels = new Map();

  try {
    const entries = await fetchCuratedEntries();

    const grouped = new Map();
    for (const e of entries) {
      const grp = String(e.group || '').trim();
      if (!matcher || !matcher.test(grp)) continue;

      const base = baseNameClean(e.name);
      const label = qualityLabel(e.name, e.url);
      const rank = qualityRank(label);

      if (!grouped.has(base)) grouped.set(base, { id: e.id || base, name: base, logo: e.logo || null, variants: [] });
      const g = grouped.get(base);

      const existingIdx = g.variants.findIndex(v => v.label === label);
      const preferThis = /a1xs\.vip/i.test(e.url);
      if (existingIdx >= 0) {
        const existing = g.variants[existingIdx];
        if (preferThis && !/a1xs\.vip/i.test(existing.url)) {
          g.variants[existingIdx] = { label, url: e.url, rank };
        }
      } else {
        g.variants.push({ label, url: e.url, rank });
      }
      if (!g.logo && e.logo) g.logo = e.logo;
    }

    channels = new Map();
    for (const [base, obj] of grouped) {
      obj.variants.sort((a,b) => b.rank - a.rank);
      obj.url = obj.variants[0]?.url || null;
      const id = obj.id || base;
      channels.set(id, { id, name: obj.name, logo: obj.logo, url: obj.url, variants: obj.variants });
    }
  } catch (_) {}

  if ((!channels || channels.size === 0) && key === 'uk_sports') {
    try {
      const text = await (await fetch(UK_SPORTS_FALLBACK, { cache: 'no-store' })).text();
      const entries = parseM3UEntries(text);
      const grouped = new Map();
      for (const e of entries) {
        const base = baseNameClean(e.name);
        const label = qualityLabel(e.name, e.url);
        const rank = qualityRank(label);
        if (!grouped.has(base)) grouped.set(base, { id: e.id || base, name: base, logo: e.logo || null, variants: [] });
        const g = grouped.get(base);
        const existingIdx = g.variants.findIndex(v => v.label === label);
        if (existingIdx < 0) g.variants.push({ label, url: e.url, rank });
        if (!g.logo && e.logo) g.logo = e.logo;
      }
      channels = new Map();
      for (const [, obj] of grouped) {
        obj.variants.sort((a,b) => b.rank - a.rank);
        obj.url = obj.variants[0]?.url || null;
        const id = obj.id || obj.name;
        channels.set(id, { id, name: obj.name, logo: obj.logo, url: obj.url, variants: obj.variants });
      }
    } catch (_) {}
  }

  cache.a1x.set(ck, { ts: Date.now(), channels });
  return channels;
}

/* ------------------------- FETCHERS (AU/NZ) ----------------------- */
async function getChannels(region, kind = 'tv') {
  if (kind === 'radio') {
    const key = `${region}:radio_m3u`;
    const c = cache.radioM3u.get(key);
    if (c && fresh(c)) return c.channels;

    let channels = new Map();
    try {
      const text = await (await fetch(radioM3uUrl(region))).text();
      channels = parseM3U(text);
    } catch (_) {}

    if (!channels || channels.size === 0) {
      try {
        const j = await (await fetch(radioJsonUrl(region))).json();
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

// --- NZ fetchers ---
async function getNZChannels(kind='tv') {
  if (kind === 'radio') {
    const c = cache.nz_radio_m3u.get('nz');
    if (c && fresh(c)) return c.channels;
    let channels = new Map();
    try { const text = await (await fetch(radioM3uUrlNZ())).text(); channels = parseM3U(text); } catch (_) {}
    cache.nz_radio_m3u.set('nz', { ts: Date.now(), channels });
    return channels;
  }
  const c = cache.nz_tv_m3u.get('nz');
  if (c && fresh(c)) return c.channels;
  let channels = new Map();
  try { const text = await (await fetch(m3uUrlNZ())).text(); channels = parseM3U(text); } catch (_) {}
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

async function getA1XEPG() {
  const key = 'a1x:epg';
  const c = cache.epg.get(key);
  if (c && fresh(c)) return c.map;
  try {
    const xml = await (await fetch(A1X_EPG_URL)).text();
    const map = await parseEPG(xml);
    cache.epg.set(key, { ts: Date.now(), map });
    return map;
  } catch (_) {
    cache.epg.set(key, { ts: Date.now(), map: new Map() });
    return new Map();
  }
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

/* ---------------------- MANIFEST (v3) --------------------- */
function genreCity(selected) {
  const s = String(selected||'').toLowerCase().replace(/[^a-z0-9+ ]+/gi,' ').trim();
  const m = s.match(/^(adelaide|brisbane|canberra|darwin|hobart|melbourne|perth|sydney)\s*tv$/);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : null;
}
function genreIs(selected, ...opts) {
  const s = String(selected||'').toLowerCase().replace(/\s+/g,' ').trim();
  return opts.some(o => s === String(o).toLowerCase());
}

/**
 * options:
 * {
 *   auTV: true, radio: true,
 *   nzTV: false, nzRadio: false, nzDefault: false,
 *   uktv:false, uksports:false, ustv:false, ussports:false, catv:false, casports:false,
 *   ausports:false, nzsports:false, eusports:false, worldsports:false, epl:false
 * }
 */
function buildManifestV3(selectedRegion, options) {
  const {
    auTV = true, radio = true,
    nzTV = false, nzRadio = false, nzDefault = false,
    uktv = false, uksports = false, ustv = false, ussports = false, catv = false, casports = false,
    ausports = false, nzsports = false, eusports = false, worldsports = false, epl = false
  } = options || {};

  const catalogs = [];
  const genreOptions = [];

  if (auTV) genreOptions.push('Traditional Channels','Other Channels','All TV Channels','Regional Channels');
  if (radio) genreOptions.push('Radio');

  if (auTV) {
    const otherCities = REGIONS.filter(r => r !== selectedRegion);
    otherCities.forEach(city => genreOptions.push(`${city} TV`));
  }
  if (ausports) genreOptions.push('AU Sports');
  if (nzTV) genreOptions.push('NZ TV');
  if (nzRadio) genreOptions.push('NZ Radio');
  if (uktv) genreOptions.push('UK TV');
  if (uksports) genreOptions.push('UK Sports');
  if (ustv) genreOptions.push('US TV');
  if (ussports) genreOptions.push('US Sports');
  if (catv) genreOptions.push('CA TV');
  if (casports) genreOptions.push('CA Sports');
  if (nzsports) genreOptions.push('NZ Sports');
  if (eusports) genreOptions.push('EU Sports');
  if (worldsports) genreOptions.push('World Sports');
  if (epl) genreOptions.push('EPL');

  let isRequired = !!nzDefault;
  if (nzDefault && nzTV) {
    const pruned = genreOptions.filter(g => g !== 'NZ TV');
    genreOptions.length = 0;
    genreOptions.push('NZ TV', ...pruned);
  }

  const displayName = nzDefault ? 'NZ' : selectedRegion;
  catalogs.push({
    type: 'tv',
    id: `au_tv_${selectedRegion}`,
    name: `AU IPTV - ${displayName}`,
    extra: [ { name: 'search' }, { name: 'genre', options: genreOptions, isRequired } ]
  });

  return {
    id: 'com.joshargh.auiptv',
    version: '2.6.3',
    name: `AU IPTV (${displayName})`,
    description: 'Australian + NZ live streams with optional international TV and Sports (curated).',
    types: ['tv'], catalogs, resources: ['catalog','meta','stream']
  };
}

/* ---------------------- ADDON BUILDER --------------------- */
const builder = new addonBuilder(
  buildManifestV3(DEFAULT_REGION, { auTV: true, radio: true })
);

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

  let isCurated     = false;
  let curatedKey    = null;

  if (genreIs(selectedGenre, 'traditional channels','traditional')) {
    catalogType = 'traditional';
  } else if (genreIs(selectedGenre, 'other channels','other')) {
    catalogType = 'other';
  } else if (genreIs(selectedGenre, 'all tv channels','all tv','all')) {
    catalogType = 'all';
  } else if (genreIs(selectedGenre, 'regional channels','regional')) {
    catalogType = 'regional';
  } else if (genreIs(selectedGenre, 'radio')) {
    contentKind = 'radio';
  } else if (genreIs(selectedGenre, 'nz tv','nz')) {
    isNZ = true; contentKind = 'tv'; catalogType = 'all';
  } else if (genreIs(selectedGenre, 'nz radio')) {
    isNZ = true; contentKind = 'radio';
  } else if (genreIs(selectedGenre, 'uk tv','uk channels'))                 { isCurated = true; curatedKey = 'uk_tv'; }
    else if (genreIs(selectedGenre, 'uk sports','uk sport'))                { isCurated = true; curatedKey = 'uk_sports'; }
    else if (genreIs(selectedGenre, 'us tv','us channels','usa tv','usa channels')) { isCurated = true; curatedKey = 'us_tv'; }
    else if (genreIs(selectedGenre, 'us sports','usa sports'))              { isCurated = true; curatedKey = 'us_sports'; }
    else if (genreIs(selectedGenre, 'ca tv','canada tv','ca channels'))     { isCurated = true; curatedKey = 'ca_tv'; }
    else if (genreIs(selectedGenre, 'ca sports','canada sports'))           { isCurated = true; curatedKey = 'ca_sports'; }
    else if (genreIs(selectedGenre, 'au sports','australia sports'))        { isCurated = true; curatedKey = 'au_sports'; }
    else if (genreIs(selectedGenre, 'nz sports','new zealand sports'))      { isCurated = true; curatedKey = 'nz_sports'; }
    else if (genreIs(selectedGenre, 'eu sports','eu/world sports'))         { isCurated = true; curatedKey = 'eu_sports'; }
    else if (genreIs(selectedGenre, 'world sports'))                        { isCurated = true; curatedKey = 'world_sports'; }
    else if (genreIs(selectedGenre, 'epl'))                                  { isCurated = true; curatedKey = 'epl'; }
  else {
    const cityName = genreCity(selectedGenre);
    if (cityName) { contentRegion = cityName; catalogType = 'all'; }
  }

  const tz = isNZ ? 'Pacific/Auckland' : (isCurated ? 'UTC' : (REGION_TZ[contentRegion] || 'Australia/Sydney'));

  let channels;
  if (isNZ) channels = await getNZChannels(contentKind);
  else if (isCurated) channels = await getCuratedGroup(curatedKey);
  else channels = await getChannels(contentRegion, contentKind);

  const epg = (contentKind === 'tv') ? (isNZ ? await getNZEPG() : (isCurated ? await getA1XEPG() : await getEPG(contentRegion))) : new Map();

  const metas = [];
  for (const [cid, ch] of channels) {
    if (contentKind === 'tv') {
      let includeChannel = true;
      let sortVal;
      if (!isNZ && !isCurated) {
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
                           : (isNZ ? 'Live NZ TV' : (isCurated && /sports|epl/i.test(curatedKey||'') ? 'Live Sports' : (isCurated ? 'Global TV' : 'Live TV'))));

      metas.push({
        id: isCurated
            ? `au|SP:${curatedKey}|${cid}|${contentKind}`
            : `au|${isNZ?'NZ':contentRegion}|${cid}|${contentKind}`,
        type: 'tv',
        name: ch.name,
        poster: posterAny(isCurated?`SP:${curatedKey}`:(isNZ?'NZ':contentRegion), ch), // square for grid
        posterShape: 'square',
        description: isNZ ? 'New Zealand TV'
                          : (isCurated ? (/sports|epl/i.test(curatedKey||'') ? 'Global Sports' : 'Global TV')
                                       : (catalogType === 'regional' ? 'Regional AU TV' : 'Live AU TV')),
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
        poster: posterAny(isNZ?'NZ':contentRegion, ch), // square for grid
        posterShape: 'square',
        description: isNZ ? 'New Zealand Radio' : 'Live AU Radio',
        releaseInfo: isNZ ? 'Live NZ Radio' : 'Live Radio'
      });
    }
  }

  if (isNZ) {
    metas.sort((a, b) => (a._sortOrder - b._sortOrder) || a.name.localeCompare(b.name));
  } else if (!isCurated && catalogType === 'traditional') {
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
  if (String(regionRaw).startsWith('SP:')) {
    const curatedKey = regionRaw.split(':')[1] || '';
    return { region: 'SP', curatedKey, cid, kind: (kindRaw === 'radio' ? 'radio' : 'tv') };
  }
  const region = (regionRaw === 'NZ') ? 'NZ' : validRegion(regionRaw);
  const kind = (kindRaw === 'radio' ? 'radio' : 'tv');
  return { region, cid, kind };
}

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: {} };
  const parsed = parseItemId(id);
  if (!parsed) return { meta: {} };
  const { region, cid, kind } = parsed;

  let tz = 'Australia/Sydney';
  let ch, channels;
  if (region === 'NZ') {
    tz = 'Pacific/Auckland';
    channels = await getNZChannels(kind);
    ch = channels.get(cid);
  } else if (region === 'SP') { // curated
    tz = 'UTC';
    channels = await getCuratedGroup(parsed.curatedKey);
    ch = channels.get(cid);
  } else {
    tz = REGION_TZ[region] || 'Australia/Sydney';
    channels = await getChannels(region, kind);
    ch = channels.get(cid);
  }
  if (!ch) return { meta: {} };

  const regionKey = region === 'SP' ? `SP:${parsed.curatedKey}` : region;

  if (kind === 'tv') {
    const progs = (region === 'NZ') ? ((await getNZEPG()).get(cid) || []) : (region === 'SP' ? ((await getA1XEPG()).get(cid) || []) : ((await getEPG(region)).get(cid) || []));
    const desc = progs.slice(0,8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
    const nowp = nowProgramme(progs);
    const squarePoster = posterAny(regionKey, ch);   // from /images (map.json)
    const m3uPoster    = m3uLogoAny(regionKey, ch);  // tvg-logo (for title area)

    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: squarePoster,                      // keep square art as poster
        background: squarePoster,                  // blurred bg
        logo: m3uPoster || squarePoster,           // << shows next to the Title
        posterShape: 'square',
        description: desc || (region === 'NZ' ? 'Live NZ television' : (region === 'SP' ? 'Curated' : 'Live television streaming')),
        releaseInfo: nowp ? `${fmtLocal(nowp.start, tz)} - ${fmtLocal(nowp.stop, tz)} | ${nowp.title}`
                          : (region === 'NZ' ? 'Live NZ TV' : 'Live TV'),
      }
    };
  } else {
    const squarePoster = posterAny(regionKey, ch);
    const m3uPoster    = m3uLogoAny(regionKey, ch);
    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: squarePoster,
        background: squarePoster,
        logo: m3uPoster || squarePoster,
        posterShape: 'square',
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

  let channels;
  if (region === 'NZ') channels = await getNZChannels(kind);
  else if (region === 'SP') channels = await getCuratedGroup(parsed.curatedKey);
  else channels = await getChannels(region, kind);

  const ch = channels.get(cid);
  if (!ch) return { streams: [] };

  if (region === 'SP' && Array.isArray(ch.variants) && ch.variants.length > 0) {
    const seen = new Set();
    const streams = [];
    for (const v of ch.variants) {
      if (!v?.url || seen.has(v.url)) continue;
      seen.add(v.url);
      streams.push({ url: v.url, title: v.label });
    }
    if (streams.length > 0) return { streams };
  }

  return { streams: [{ url: ch.url, title: 'Play' }] };
});

/* ----------------------- LANDING PAGE --------------------- */
const CONFIG_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="/AUIPTVLOGO.svg" type="image/svg+xml" sizes="any">
<title>AU IPTV v2.6.3</title><meta http-equiv="Cache-Control" content="no-store"/>
<style>
:root{color-scheme:dark;--bg:#0b0c0f;--card:#14161a;--muted:#9aa4b2;--text:#ecf2ff;--ok:#34c759;--okText:#04210d;--line:#22252b;--accent:#4fc3f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
.wrap{display:grid;place-items:center;padding:28px}.card{width:min(960px,92vw);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{margin:0 0 6px;font-size:26px;display:flex;align-items:center;gap:8px}
.badge{display:inline-block;line-height:1;padding:4px 8px;border-radius:999px;background:var(--accent);color:#001219;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}
.lead{margin:0 0 14px;color:var(--muted)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}
label{font-size:13px;color:var(--muted)}select{background:#0f1115;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:#101318;color:#fff;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{background:#0e1218}.btn-primary{background:var(--ok);border-color:var(--ok);color:var(--okText);font-weight:700}
.btn-ghost{background:transparent}
code{display:block;margin-top:10px;padding:10px 12px;background:#0f1115;border:1px solid var(--line);border-radius:10px;color:#a7f3d0;overflow:auto;word-break:break-all;font-size:12px}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
details.acc{background:#0f1115;border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}
details.acc>summary{cursor:pointer;padding:10px 12px;font-weight:700;color:var(--text);list-style:none}
details.acc[open]>summary{border-bottom:1px solid var(--line)}
.acc-body{padding:10px 12px}
.section-title{margin-top:6px;font-weight:700;color:#cfe8ff}
.group{display:flex;flex-wrap:wrap;gap:18px;align-items:center}
</style></head><body>
<div class="wrap"><div class="card">

<h1 style="display:flex; justify-content:center; align-items:center">
  <img src="/AUIPTVLOGO.svg" alt="" style="height:256px"/>
</h1>

<h1>
  AU IPTV <span class="badge">v2.6.3</span>
  <span class="spacer"></span>
  <span id="installs" class="h1-installs" aria-live="polite" title="Total installs" style="font-size:12px;color:#9aa4b2">
    Installs: —
  </span>
</h1>

<p class="lead">AU + NZ live TV & radio for Stremio. Add optional international TV and Sports (curated). Pick your main AU city, tick what you want, then install. Use the <b>Genre</b> dropdown in Stremio to switch between what you enabled.</p>

<hr>
<div class="row">
  <label for="region">Main AU City (for AU EPG)</label>
  <select id="region">
    <option>Adelaide</option><option selected>Brisbane</option><option>Canberra</option><option>Darwin</option>
    <option>Hobart</option><option>Melbourne</option><option>Perth</option><option>Sydney</option>
  </select>
</div>

<div class="row group">
  <span class="section-title">Australia</span>
  <label><input type="checkbox" id="auTv" checked> AU TV (Traditional/Other/Regional)</label>
  <label><input type="checkbox" id="radio" checked> AU Radio</label>
  <label><input type="checkbox" id="auSports"> AU Sports</label>
</div>

<details class="acc" id="nzAcc" open>
  <summary>New Zealand</summary>
  <div class="acc-body group">
    <label><input type="checkbox" id="nz"> NZ TV</label>
    <label><input type="checkbox" id="nzRadio"> NZ Radio</label>
    <label id="nzDefaultWrap" style="display:none"><input type="checkbox" id="nzDefault"> Set NZ as default</label>
    <label><input type="checkbox" id="nzSports"> NZ Sports</label>
  </div>
</details>

<details class="acc" id="intlAcc">
  <summary>International (Curated)</summary>
  <div class="acc-body">
    <div class="group">
      <strong>UK</strong>
      <label><input type="checkbox" id="ukTV"> UK TV Channels</label>
      <label><input type="checkbox" id="ukSports"> UK Sports</label>
    </div>
    <div class="group" style="margin-top:8px">
      <strong>US</strong>
      <label><input type="checkbox" id="usTV"> US TV Channels</label>
      <label><input type="checkbox" id="usSports"> US Sports</label>
    </div>
    <div class="group" style="margin-top:8px">
      <strong>Canada</strong>
      <label><input type="checkbox" id="caTV"> CA TV Channels</label>
      <label><input type="checkbox" id="caSports"> CA Sports</label>
    </div>
    <div class="group" style="margin-top:8px">
      <strong>Other</strong>
      <label><input type="checkbox" id="epl"> EPL</label>
      <label><input type="checkbox" id="euSports"> EU Sports</label>
      <label><input type="checkbox" id="worldSports"> World Sports</label>
    </div>
  </div>
</details>

<div class="row">
  <button id="open" class="btn btn-primary">Open in Stremio Web</button>
  <a id="manifestLink" class="btn btn-ghost" href="#" target="_blank" rel="noopener">Open manifest.json</a>
  <button id="copy" class="btn">Copy manifest URL</button>
</div>

<code id="preview">—</code>
<div class="hint">Web installer: <span id="weburl">—</span></div>

</div>
</div>

<script>
const $ = s => document.querySelector(s);

const AU_CITIES = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney'];
function region() {
  const raw = ($('#region').value || 'Brisbane').trim();
  return encodeURIComponent(raw);
}
function pathPrefix() {
  const parts = [region()];
  if (!$('#auTv').checked) parts.push('noau');
  if ($('#radio').checked) parts.push('radio');
  if ($('#auSports').checked) parts.push('ausports');
  if ($('#nz').checked) parts.push('nz');
  if ($('#nzRadio').checked) parts.push('nzradio');
  if ($('#nzDefault').checked) parts.push('nzdefault');
  if ($('#nzSports').checked) parts.push('nzsports');
  if ($('#ukTV').checked) parts.push('uktv');
  if ($('#ukSports').checked) parts.push('uksports');
  if ($('#usTV').checked) parts.push('ustv');
  if ($('#usSports').checked) parts.push('ussports');
  if ($('#caTV').checked) parts.push('catv');
  if ($('#caSports').checked) parts.push('casports');
  if ($('#euSports').checked) parts.push('eusports');
  if ($('#worldSports').checked) parts.push('worldsports');
  if ($('#epl').checked) parts.push('epl');
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
['change','input'].forEach(ev=>{ document.addEventListener(ev, (e)=>{ if (e.target && e.target.id) update(); }); });
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position='absolute'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.select();
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
  e.preventDefault(); update();
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
update();
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

// stats endpoint for landing page — in-memory only
app.get('/stats', (_req, res) => {
  res.json({ installs: _memStats.installs || 0 });
});

// serve logo + favicon aliases
app.get(['/AUIPTVLOGO.svg','/favicon.svg'], (_req, res) => {
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'AUIPTVLOGO.svg'));
});
app.get('/favicon.ico', (_req, res) => res.redirect(302, '/AUIPTVLOGO.svg'));

// helper to build absolute base URL (for manifest logo)
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

function parseFlagsFromPath(reqPath) {
  const parts = reqPath.split('/').filter(Boolean);
  const flags = new Set(parts.slice(1)); // after region
  if (flags.has('sports')) ['uksports','ussports','casports','ausports','nzsports','eusports','worldsports','epl'].forEach(f=>flags.add(f));
  if (flags.has('ukskysports') || flags.has('ukskyother')) flags.add('uksports');
  return { regionRaw: decodeURIComponent(parts[0] || DEFAULT_REGION), flags };
}

function manifestResponderV2(req, res) {
  try {
    markInstall(req);
    const { regionRaw, flags } = parseFlagsFromPath(req.path);
    const region = validRegion(regionRaw);

    const man = buildManifestV3(region, {
      auTV: !flags.has('noau'),
      radio: flags.has('radio'),
      nzTV: flags.has('nz'),
      nzRadio: flags.has('nzradio'),
      nzDefault: flags.has('nzdefault'),
      uktv: flags.has('uktv'),
      uksports: flags.has('uksports'),
      ustv: flags.has('ustv'),
      ussports: flags.has('ussports'),
      catv: flags.has('catv'),
      casports: flags.has('casports'),
      ausports: flags.has('ausports'),
      nzsports: flags.has('nzsports'),
      eusports: flags.has('eusports'),
      worldsports: flags.has('worldsports'),
      epl: flags.has('epl')
    });

    man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
    man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
    res.json(man);
  } catch (e) {
    console.error('manifest v3 error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}

app.get(/^\/[^/]+(?:\/[^/]+)*\/manifest\.json$/, manifestResponderV2);

// Legacy v1 endpoints (kept for compatibility with old installs)
function buildManifestV1(selectedRegion, includeRadio) {
  const catalogs = [];
  const genreOptions = ['Traditional Channels','Other Channels','All TV Channels','Regional Channels'];
  if (includeRadio) genreOptions.push('Radio');
  const otherCities = REGIONS.filter(r => r !== selectedRegion);
  otherCities.forEach(city => genreOptions.push(`${city} TV`));

  catalogs.push({
    type: 'tv',
    id: `au_tv_${selectedRegion}`,
    name: `AU TV - ${selectedRegion}`,
    extra: [ { name: 'search' }, { name: 'genre', options: genreOptions, isRequired: false } ]
  });

  return {
    id: 'com.joshargh.auiptv',
    version: '1.5.0',
    name: `AU IPTV (${selectedRegion})`,
    description: `Australian live TV and Radio - Main city: ${selectedRegion}. Use Genre filter to access other content types and cities.`,
    types: ['tv'], catalogs, resources: ['catalog','meta','stream']
  };
}

function manifestResponderLegacy(req, res) {
  try {
    markInstall(req);
    const region = validRegion(req.params.region);
    const includeRadio = /\/radio(\/|$)/.test(req.path);
    const man = buildManifestV1(region, includeRadio);
    man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
    man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
    res.json(man);
  } catch (e) {
    console.error('manifest legacy error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}

app.get('/:region/manifest.json', manifestResponderLegacy);
app.get('/:region/radio/manifest.json', manifestResponderLegacy);

app.get('/manifest.json', (req, res) => {
  const man = buildManifestV3(DEFAULT_REGION, { auTV: true, radio: true });
  man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
  man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
  res.json(man);
});

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

module.exports.handler = serverless(app);

//if (require.main === module) {
//  const PORT = process.env.PORT || 7000;
//  app.listen(PORT, () => console.log('Listening on', PORT));
//}
