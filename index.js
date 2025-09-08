/**
 * AU IPTV — v2.7.0
 * - AU/NZ live channels (i.mjh.nz)
 * - Curated packs (A1X) + multi-quality variants
 * - Dynamic "Additional Packs" from external M3U (tokened/short-lived)
 * - Stremio addon + simple landing served from /public/index.html
 */

'use strict';

const express = require('express');
const serverless = require('serverless-http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');

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

// stremio-addons.net signature (optional)
const STREMIO_ADDONS_CONFIG = {
  issuer: 'https://stremio-addons.net',
  signature: process.env.STREMIO_ADDONS_SIGNATURE || null
};

// Posters via /images repo (optional map.json)
const IMAGES_BASE = process.env.IMAGES_BASE || 'https://raw.githubusercontent.com/josharghhh/AU-IPTV_StremioAddon/main';
let POSTER_MAP = {};
try { POSTER_MAP = require('./map.json'); } catch { POSTER_MAP = {}; }

// Extras (dynamic packs) M3U
const EXTRAS_M3U_URL = process.env.EXTRAS_M3U_URL ||
  'https://gist.githubusercontent.com/One800burner/dae77ddddc1b83d3a4d7b34d2bd96a5e/raw/1roguevip.m3u';

// Curated (A1X)
const A1X_CURATED_PRIMARY = 'https://bit.ly/a1xstream';
const A1X_CURATED_BACKUP  = 'https://a1xs.vip/a1xstream';
const A1X_CURATED_DIRECT  = 'https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u';
const A1X_EPG_URL = 'https://bit.ly/a1xepg';
const UK_SPORTS_FALLBACK = 'https://forgejo.plainrock127.xyz/Mystique-Play/Mystique/raw/branch/main/countries/uk_sports.m3u';

// stats (naive)
const STATS_SEED = Number(process.env.STATS_SEED || 498);
let _memStats = { installs: STATS_SEED };

/* --------------------------- CACHE ------------------------ */
const CACHE_TTL = 15 * 60 * 1000; // 15 min
const SHORT_TTL = Number(process.env.SHORT_TTL_MS || 90 * 1000); // 90s for tokened links
const fresh = (e, ttl = CACHE_TTL) => e && (Date.now() - e.ts) < ttl;
const validRegion = (r) => (REGIONS.includes(r) ? r : DEFAULT_REGION);

const cache = {
  // AU/NZ
  m3u: new Map(), epg: new Map(), radioM3u: new Map(),
  nz_tv_m3u: new Map(), nz_radio_m3u: new Map(), nz_epg: new Map(),

  // curated
  a1x_text: null, a1x_entries: null, curated_groups: new Map(), a1x_epg: null,

  // extras
  extras_text: null, extras_groups: null
};

function markInstall() { _memStats.installs = (_memStats.installs || 0) + 1; }

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
      const logom = line.match(/tvg-logo="([^"]+)"/i);
      const grp   = line.match(/group-title="([^"]+)"/i);
      cur = { id: idm ? idm[1] : name, name, logo: logom ? logom[1] : null, group: grp ? grp[1] : null };
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur) cur.group = line.slice(8).trim();
    } else if (cur && !line.startsWith('#')) {
      // keep only the first URL-looking token
      const m = line.match(/https?:\/\/\S+/);
      if (m) channels.set(cur.id, { ...cur, url: m[0] });
      cur = null;
    }
  }
  return channels;
}
function parseM3UEntries(text) {
  // Robust: keeps only the first http(s) URL after each #EXTINF block
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
      const m = line.match(/https?:\/\/\S+/);
      if (m) out.push({ ...meta, url: m[0] });
      meta = null;
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
        const start = p.$?.start || '';
        const stop  = p.$?.stop  || '';
        const title = (Array.isArray(p.title) ? p.title[0] : p.title) || '';
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push({ start, stop, title });
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

/* ----------------- AU classification + order --------------- */
function isOtherChannel(name = '') {
  const u = String(name).toUpperCase();
  const normalized = u.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const OTHER_CHANNELS = [
    'ABC BUSINESS','ABC BUSINESS IN 90 SECONDS','ABC NEWS IN 90 SECONDS',
    'ABC SPORT IN 90 SECONDS','ABC WEATHER IN 90 SECONDS','SBS ARABIC','SBS CHILL','SBS POPASIA',
    'SBS RADIO 1','SBS RADIO 2','SBS RADIO 3','SBS SOUTH ASIAN','SBS WORLD MOVIES','SBS WORLD WATCH','SBS WORLDWATCH',
    'SBS FOOD','SBS VICELAND','8 OUT OF 10 CATS'
  ];
  if (OTHER_CHANNELS.includes(u)) return true;
  if (/\bHAVE YOU BEEN PAYING ATTENTION\b/.test(normalized)) return true;
  if (/\bHYBPA\b/.test(normalized)) return true;
  if (/(?:\b8\b|\bEIGHT\b)\s*(?:OUT\s*OF\s*)?\b10\b\s*CATS(?:\s*DOES\s*COUNTDOWN)?\b/.test(normalized)) return true;
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
  for (const group of TRADITIONAL_CHANNELS) if (group.some(g => u.includes(g))) return true;
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
const auTradOrderValue = (name='') => {
  const u = name.toUpperCase();
  for (const key of AU_TRAD_ORDER) if (u.includes(key)) return AU_TRAD_INDEX.get(key);
  return 10000;
};

/* ----------------- Poster helpers -------------------------- */
function posterFromMapAbs(chId) {
  const rel = POSTER_MAP?.[chId];
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  const p = rel.startsWith('/images/') ? rel : `/images/${String(rel).replace(/^\/+/, '')}`;
  return `${IMAGES_BASE}${p}`;
}
function posterAny(regionOrKey, ch) {
  const mapped = posterFromMapAbs(ch.id);
  if (mapped) return mapped;
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  if (regionOrKey === 'NZ') return `${baseNZ()}/logo/${encodeURIComponent(ch.id)}.png`;
  if (String(regionOrKey || '').startsWith('SP') || String(regionOrKey || '').startsWith('EX')) return '';
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}
function m3uLogoAny(regionOrKey, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  if (regionOrKey === 'NZ') return `${baseNZ()}/logo/${encodeURIComponent(ch.id)}.png`;
  if (String(regionOrKey || '').startsWith('SP') || String(regionOrKey || '').startsWith('EX')) return '';
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}

/* --------------------- AU/NZ sources ----------------------- */
const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;

const baseNZ        = () => `https://i.mjh.nz/nz`;
const m3uUrlNZ      = () => `${baseNZ()}/raw-tv.m3u8`;
const radioM3uUrlNZ = () => `${baseNZ()}/raw-radio.m3u8`;
const epgUrlNZ      = () => `${baseNZ()}/epg.xml`;

/* ---------------- Curated (A1X) helpers -------------------- */
function norm(s='') { return String(s||'').toLowerCase(); }
function isUHD(name = '', url = '') {
  const n = norm(name), u = norm(url);
  return /\b(uhd|4k|2160p?)\b/.test(n) || /(2160|uhd|4k|hevc|main10|h\.?265)/.test(u);
}
function isFHD(name = '', url = '') { const s = norm(name + ' ' + url); return /\b(fhd|1080p?)\b/.test(s) || /(^|[^0-9])1080([^0-9]|$)/.test(s); }
function isHD (name = '', url = '') { const s = norm(name + ' ' + url); return /\bhd\b/.test(s) || /\b720p?\b/.test(s) || /(^|[^0-9])720([^0-9]|$)/.test(s); }
function qualityLabel(name='',url=''){ if (isUHD(name,url)) return 'UHD / 4K'; if (isFHD(name,url)) return 'FHD / 1080p'; if (isHD(name,url)) return 'HD / 720p'; return 'SD'; }
function qualityRank(label=''){ const l=String(label).toUpperCase(); if (l.includes('UHD')) return 3; if (l.includes('FHD')) return 2; if (l.includes('HD')) return 1; return 0; }
function baseNameClean(name=''){ return String(name).replace(/^\s*(?:UKI?\s*\|\s*|\[[^\]]+\]\s*)/i,'').replace(/\b(UHD|4K|2160p?|FHD|1080p|HD|720p|SD)\b/ig,'').replace(/\s{2,}/g,' ').trim(); }

const tvMatcher = (...labels) =>
  new RegExp(`^\\s*(?:${labels.join('|')})\\s*(?:TV\\s*Channels?|Channels?)\\s*$`, 'i');
const sportsMatcher = (...labels) =>
  new RegExp(`^\\s*(?:${labels.join('|')})\\s*Sports?(?:\\s*Channels?)?\\s*$`, 'i');

const A1X_GROUPS = {
  epl:              /^EPL$/i,
  uk_sports:        sportsMatcher('UK','United\\s*Kingdom'),
  us_sports:        sportsMatcher('US','USA','United\\s*States'),
  ca_sports:        sportsMatcher('CA','Canada'),
  au_sports:        sportsMatcher('AU','Australia'),
  nz_sports:        sportsMatcher('NZ','New\\s*Zealand'),
  eu_sports:        sportsMatcher('EU','Europe','European'),
  world_sports:     sportsMatcher('World','International'),

  uk_tv:            tvMatcher('UK','United\\s*Kingdom'),
  us_tv:            tvMatcher('US','USA','United\\s*States'),
  ca_tv:            tvMatcher('CA','Canada'),
};

async function fetchCuratedM3U(forceFresh=false) {
  if (!forceFresh && cache.a1x_text && fresh(cache.a1x_text, CACHE_TTL)) return cache.a1x_text.text;
  const headers = { 'User-Agent': 'Mozilla/5.0 (AUIPTV-Addon)' };
  let text = '';
  const sources = [A1X_CURATED_PRIMARY, A1X_CURATED_BACKUP, A1X_CURATED_DIRECT];
  for (const source of sources) {
    try {
      const r = await fetch(source, { redirect: 'follow', headers });
      if (r.ok) { text = await r.text(); if (text && text.length > 100) break; }
    } catch {}
  }
  cache.a1x_text = { ts: Date.now(), text: String(text || '') };
  return String(text || '');
}
async function fetchCuratedEntries(forceFresh=false) {
  if (!forceFresh && cache.a1x_entries && fresh(cache.a1x_entries, CACHE_TTL)) return cache.a1x_entries.entries;
  const text = await fetchCuratedM3U(forceFresh);
  const entries = parseM3UEntries(text);
  cache.a1x_entries = { ts: Date.now(), entries };
  return entries;
}
async function getCuratedGroup(key, { forceFresh = false } = {}) {
  const ck = `curated:${key}`;
  const c = cache.curated_groups.get(ck);
  if (!forceFresh && c && fresh(c, CACHE_TTL)) return c.channels;

  const matcher = A1X_GROUPS[key];
  let channels = new Map();

  try {
    const entries = await fetchCuratedEntries(forceFresh);

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
        if (preferThis && !/a1xs\.vip/i.test(existing.url)) g.variants[existingIdx] = { label, url: e.url, rank };
      } else {
        g.variants.push({ label, url: e.url, rank });
      }
      if (!g.logo && e.logo) g.logo = e.logo;
    }

    channels = new Map();
    for (const [_, obj] of grouped) {
      obj.variants.sort((a,b) => b.rank - a.rank);
      obj.url = obj.variants[0]?.url || null;
      const id = obj.id || obj.name;
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
        if (g.variants.findIndex(v => v.label === label) < 0) g.variants.push({ label, url: e.url, rank });
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

  cache.curated_groups.set(ck, { ts: Date.now(), channels });
  return channels;
}

/* ---------------------- EXTRAS (Dynamic) ------------------- */
const slugify = (s='') =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48) || 'pack';

function hash32(s='') { // stable-ish short id
  let h = 0; for (let i=0;i<s.length;i++) { h = (h<<5) - h + s.charCodeAt(i); h |= 0; }
  return (h>>>0).toString(36);
}

async function fetchExtrasM3U(forceFresh = false) {
  if (!forceFresh && cache.extras_text && fresh(cache.extras_text, SHORT_TTL)) return cache.extras_text.text;
  try {
    const r = await fetch(EXTRAS_M3U_URL, { redirect: 'follow' });
    const t = await r.text();
    cache.extras_text = { ts: Date.now(), text: t || '' };
    return t || '';
  } catch {
    cache.extras_text = { ts: Date.now(), text: '' };
    return '';
  }
}

// IMPORTANT FIX: group by name (slug) and merge duplicates as variants
async function getExtrasGroups({ forceFresh = false } = {}) {
  if (!forceFresh && cache.extras_groups && fresh(cache.extras_groups, SHORT_TTL))
    return cache.extras_groups.groups;

  const text = await fetchExtrasM3U(forceFresh);
  const entries = parseM3UEntries(text);

  const map = new Map(); // slug -> { slug, name, channels: Map(nameSlug -> channelObj) }
  for (const e of entries) {
    const gname = (e.group || 'Other').trim();
    const gslug = slugify(gname);
    if (!map.has(gslug)) map.set(gslug, { slug: gslug, name: gname, channels: new Map() });

    const nameSlug = slugify(e.name) || slugify(e.id);
    const label = qualityLabel(e.name, e.url);
    const rank  = qualityRank(label);

    const chMap = map.get(gslug).channels;
    const existing = chMap.get(nameSlug);
    if (!existing) {
      const stableId = `${nameSlug}-${hash32(e.url)}`;
      chMap.set(nameSlug, {
        id: stableId,
        name: e.name,
        logo: e.logo || null,
        url: e.url,
        variants: [{ label, url: e.url, rank }]
      });
    } else {
      if (!existing.variants.some(v => v.url === e.url)) {
        existing.variants.push({ label, url: e.url, rank });
        existing.variants.sort((a,b)=>b.rank-a.rank);
        existing.url = existing.variants[0].url;
      }
    }
  }

  cache.extras_groups = { ts: Date.now(), groups: map };
  return map;
}

/* ----------------------- AU/NZ fetchers -------------------- */
async function getChannels(region, kind = 'tv') {
  if (kind === 'radio') {
    const key = `${region}:radio_m3u`;
    const c = cache.radioM3u.get(key);
    if (c && fresh(c)) return c.channels;

    let channels = new Map();
    try { const text = await (await fetch(radioM3uUrl(region))).text(); channels = parseM3U(text); } catch {}
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
// NZ
async function getNZChannels(kind='tv') {
  if (kind === 'radio') {
    const c = cache.nz_radio_m3u.get('nz');
    if (c && fresh(c)) return c.channels;
    let channels = new Map();
    try { const text = await (await fetch(radioM3uUrlNZ())).text(); channels = parseM3U(text); } catch {}
    cache.nz_radio_m3u.set('nz', { ts: Date.now(), channels }); return channels;
  }
  const c = cache.nz_tv_m3u.get('nz');
  if (c && fresh(c)) return c.channels;
  let channels = new Map();
  try { const text = await (await fetch(m3uUrlNZ())).text(); channels = parseM3U(text); } catch {}
  cache.nz_tv_m3u.set('nz', { ts: Date.now(), channels }); return channels;
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
  if (cache.a1x_epg && fresh(cache.a1x_epg, CACHE_TTL)) return cache.a1x_epg.map;
  try {
    const xml = await (await fetch(A1X_EPG_URL)).text();
    const map = await parseEPG(xml);
    cache.a1x_epg = { ts: Date.now(), map };
    return map;
  } catch { cache.a1x_epg = { ts: Date.now(), map: new Map() }; return new Map(); }
}

/* ---------------------- Manifest helpers ------------------ */
function genreCity(selected) {
  const s = String(selected||'').toLowerCase().replace(/[^a-z0-9+ ]+/gi,' ').trim();
  const m = s.match(/^(adelaide|brisbane|canberra|darwin|hobart|melbourne|perth|sydney)\s*tv$/);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : null;
}
const genreIs = (selected, ...opts) => opts.some(o => String(selected||'').toLowerCase().trim() === String(o).toLowerCase());

function buildHeaders(url) {
  // Always provide UA/Referer/Origin for curated / extras
  let origin = 'https://www.google.com';
  let referer = 'https://www.google.com/';
  try {
    const uo = new URL(url);
    origin = `${uo.protocol}//${uo.hostname}`;
    referer = `${origin}/`;
  } catch {}
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Referer': referer,
    'Origin': origin,
    'Accept': '*/*',
    'Accept-Language': 'en-AU,en;q=0.9'
  };
}

/* ---------------------- Manifest (v3) --------------------- */
function buildManifestV3(selectedRegion, genreOptions) {
  return {
    id: 'com.joshargh.auiptv',
    version: '2.7.0',
    name: `AU IPTV (${selectedRegion})`,
    description: 'Australian + NZ live streams with optional international TV, Sports and Additional Packs.',
    types: ['tv'],
    catalogs: [{
      type: 'tv',
      id: `au_tv_${selectedRegion}`,
      name: `AU IPTV - ${selectedRegion}`,
      extra: [ { name: 'search' }, { name: 'genre', options: genreOptions, isRequired: false } ]
    }],
    resources: ['catalog','meta','stream']
  };
}

/* ---------------------- Addon Builder --------------------- */
const builder = new addonBuilder(buildManifestV3(DEFAULT_REGION, [
  'Traditional Channels','Other Channels','All TV Channels','Regional Channels','Radio'
]));

/* ---------------------- Catalog Handler ------------------- */
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== 'tv') return { metas: [] };
  const m = id.match(/^au_tv_(.+)$/);
  const region = validRegion(m ? m[1] : DEFAULT_REGION);

  const selectedGenre = String(extra?.genre || 'Traditional Channels');
  let contentRegion = region;
  let contentKind = 'tv';
  let catalogType = 'traditional';
  let isNZ = false;
  let isCurated = false; let curatedKey = null;
  let isExtras = false; let extrasSlug = null;

  if (genreIs(selectedGenre, 'traditional channels','traditional')) catalogType = 'traditional';
  else if (genreIs(selectedGenre, 'other channels','other')) catalogType = 'other';
  else if (genreIs(selectedGenre, 'all tv channels','all tv','all')) catalogType = 'all';
  else if (genreIs(selectedGenre, 'regional channels','regional')) catalogType = 'regional';
  else if (genreIs(selectedGenre, 'radio')) contentKind = 'radio';
  else if (genreIs(selectedGenre, 'nz tv','nz')) { isNZ = true; contentKind = 'tv'; catalogType = 'all'; }
  else if (genreIs(selectedGenre, 'nz radio')) { isNZ = true; contentKind = 'radio'; }
  else if (/^extra:\s*/i.test(selectedGenre)) { isExtras = true; extrasSlug = slugify(selectedGenre.replace(/^extra:\s*/i,'')); }
  else {
    // curated sets
    const lower = selectedGenre.toLowerCase();
    const keyMap = {
      'uk tv':'uk_tv','uk channels':'uk_tv',
      'uk sports':'uk_sports','uk sport':'uk_sports',
      'us tv':'us_tv','usa tv':'us_tv','us channels':'us_tv','usa channels':'us_tv',
      'us sports':'us_sports','usa sports':'us_sports',
      'ca tv':'ca_tv','canada tv':'ca_tv','ca channels':'ca_tv',
      'ca sports':'ca_sports','canada sports':'ca_sports',
      'au sports':'au_sports','nz sports':'nz_sports',
      'eu sports':'eu_sports','world sports':'world_sports','epl':'epl'
    };
    curatedKey = keyMap[lower] || null;
    isCurated = !!curatedKey;
    if (!isCurated) {
      const cityName = genreCity(selectedGenre);
      if (cityName) { contentRegion = cityName; catalogType = 'all'; }
    }
  }

  // Build genre options dynamically (NZ cities + extras)
  const genreOptions = ['Traditional Channels','Other Channels','All TV Channels','Regional Channels','Radio',
                        'NZ TV','NZ Radio',
                        'UK TV','UK Sports','US TV','US Sports','CA TV','CA Sports','AU Sports','NZ Sports','EU Sports','World Sports','EPL'];
  // add extras groups (names only)
  try {
    const groups = await getExtrasGroups({ forceFresh: false });
    for (const [, g] of groups) genreOptions.push(`Extra: ${g.name}`);
  } catch {}

  // Return updated manifest when the app requests it
  builder.manifest = buildManifestV3(region, genreOptions);

  // Pull channels
  let channels;
  if (isNZ) channels = await getNZChannels(contentKind);
  else if (isCurated) channels = await getCuratedGroup(curatedKey);
  else if (isExtras) {
    const groups = await getExtrasGroups({ forceFresh: false });
    const g = groups.get(extrasSlug);
    channels = g ? g.channels : new Map();
  } else channels = await getChannels(contentRegion, contentKind);

  const tz = isNZ ? 'Pacific/Auckland' : (isCurated ? 'UTC' : (REGION_TZ[contentRegion] || 'Australia/Sydney'));
  const epg = (contentKind === 'tv')
    ? (isNZ ? await getNZEPG() : (isCurated || isExtras ? new Map() : await getEPG(contentRegion)))
    : new Map();

  const metas = [];
  for (const [cid, ch] of channels) {
    if (contentKind === 'tv') {
      let include = true; let sortVal;
      if (!isNZ && !isCurated && !isExtras) {
        const traditional = isTraditionalChannel(ch.name);
        const other = isOtherChannel(ch.name);
        const regional = false;
        if (catalogType === 'traditional') { include = traditional && !regional && !other; if (include) sortVal = auTradOrderValue(ch.name); }
        else if (catalogType === 'other') { include = (other || (!traditional && !regional)) && !regional; }
        else if (catalogType === 'regional') { include = regional; }
        else include = !regional;
      }
      if (!include) continue;

      const list = epg.get(cid) || [];
      const nowp = nowProgramme(list);
      const release = nowp ? `${fmtLocal(nowp.start, tz)} | ${nowp.title}`
                           : (list[0] ? `${fmtLocal(list[0].start, tz)} | ${list[0].title}`
                                      : (isNZ ? 'Live NZ TV' : (isCurated ? 'Curated TV' : (isExtras ? 'Additional Pack' : 'Live AU TV'))));

      const regionKey = isCurated ? `SP:${curatedKey}` : (isExtras ? `EX:${extrasSlug}` : (isNZ ? 'NZ' : contentRegion));
      metas.push({
        id: isCurated ? `au|SP:${curatedKey}|${cid}|tv`
            : isExtras ? `au|EX:${extrasSlug}|${cid}|tv`
            : `au|${isNZ?'NZ':contentRegion}|${cid}|tv`,
        type: 'tv',
        name: ch.name,
        poster: posterAny(regionKey, ch),
        posterShape: 'square',
        description: isNZ ? 'New Zealand TV' : (isCurated ? 'Curated' : (isExtras ? 'Additional Pack' : 'Live AU TV')),
        releaseInfo: release,
        _sortOrder: (catalogType === 'traditional' && !isCurated && !isExtras && !isNZ) ? (sortVal ?? 10000) : undefined
      });
    } else {
      const regionKey = isNZ ? 'NZ' : contentRegion;
      metas.push({
        id: `au|${regionKey}|${cid}|radio`,
        type: 'tv',
        name: ch.name,
        poster: posterAny(regionKey, ch),
        posterShape: 'square',
        description: isNZ ? 'New Zealand Radio' : 'Live AU Radio',
        releaseInfo: isNZ ? 'Live NZ Radio' : 'Live Radio'
      });
    }
  }

  if (!isCurated && !isExtras && catalogType === 'traditional')
    metas.sort((a,b)=>(a._sortOrder-b._sortOrder)||a.name.localeCompare(b.name));
  else metas.sort((a,b)=>a.name.localeCompare(b.name));
  metas.forEach(m=>delete m._sortOrder);

  return { metas };
});

/* ------------------------ Meta Handler -------------------- */
function parseItemId(id) {
  const p = String(id||'').split('|');
  if (p.length < 3 || p[0] !== 'au') return null;
  const [, regionRaw, cid, kindRaw = 'tv'] = p;
  if (String(regionRaw).startsWith('SP:')) return { region: 'SP', curatedKey: regionRaw.split(':')[1], cid, kind: kindRaw };
  if (String(regionRaw).startsWith('EX:')) return { region: 'EX', extrasSlug: regionRaw.split(':')[1], cid, kind: kindRaw };
  const region = (regionRaw === 'NZ') ? 'NZ' : validRegion(regionRaw);
  return { region, cid, kind: kindRaw };
}

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: {} };
  const parsed = parseItemId(id);
  if (!parsed) return { meta: {} };
  const { region, cid, kind } = parsed;

  let ch, channels, tz = 'Australia/Sydney';
  if (region === 'NZ') { tz = 'Pacific/Auckland'; channels = await getNZChannels(kind); ch = channels.get(cid); }
  else if (region === 'SP') { tz = 'UTC'; channels = await getCuratedGroup(parsed.curatedKey); ch = channels.get(cid); }
  else if (region === 'EX') { tz = 'UTC'; const g = (await getExtrasGroups({ forceFresh: false })).get(parsed.extrasSlug); ch = g?.channels.get(cid); }
  else { tz = REGION_TZ[region] || 'Australia/Sydney'; channels = await getChannels(region, kind); ch = channels.get(cid); }
  if (!ch) return { meta: {} };

  const regionKey = region === 'SP' ? `SP:${parsed.curatedKey}` : (region === 'EX' ? `EX:${parsed.extrasSlug}` : region);

  if (kind === 'radio') {
    const squarePoster = posterAny(regionKey, ch);
    const m3uPoster = (region === 'SP' || region === 'EX') ? null : m3uLogoAny(regionKey, ch);
    return { meta: {
      id, type:'tv', name:ch.name, poster:squarePoster, background:squarePoster, logo:m3uPoster || squarePoster,
      posterShape:'square', description: region==='NZ'?'Live NZ radio streaming':'Live radio streaming',
      releaseInfo: region==='NZ'?'Live NZ Radio':'Live Radio'
    }};
  }

  const progs = (region === 'NZ')
    ? ((await getNZEPG()).get(cid) || [])
    : (region === 'SP' || region === 'EX'
        ? []
        : ((await getEPG(region)).get(cid) || []));
  const desc = progs.slice(0, 8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
  const nowp = nowProgramme(progs);
  const squarePoster = posterAny(regionKey, ch);
  const m3uPoster = (region === 'SP' || region === 'EX') ? null : m3uLogoAny(regionKey, ch);

  return { meta: {
    id, type:'tv', name:ch.name,
    poster:squarePoster, background:squarePoster, logo:m3uPoster || squarePoster,
    posterShape:'square',
    description: desc || (region==='NZ'?'Live NZ television':(region==='SP'?'Curated':(region==='EX'?'Additional Pack':'Live television streaming'))),
    releaseInfo: nowp ? `${fmtLocal(nowp.start,tz)} - ${fmtLocal(nowp.stop,tz)} | ${nowp.title}`
                      : (region==='NZ'?'Live NZ TV':(region==='SP'?'Curated TV':(region==='EX'?'Additional Pack':'Live TV')))
  }};
});

/* ------------------------- Stream Handler ----------------- */
function curatedRedirectUrl({ curatedKey, cid, label }) {
  const base = publicBase();
  const u = `${base}/redir/${encodeURIComponent(curatedKey)}/${encodeURIComponent(cid)}.m3u8`;
  return label ? `${u}?label=${encodeURIComponent(label)}` : u;
}
let PUBLIC_BASE = process.env.PUBLIC_BASE_URL || null;
app.use((req, _res, next) => { try {
  const b = baseUrl(req); if (b && (!PUBLIC_BASE || PUBLIC_BASE !== b)) PUBLIC_BASE = b;
} catch{} next(); });
const publicBase = () => PUBLIC_BASE || process.env.PUBLIC_BASE_URL || '';

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv') return { streams: [] };
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const { region, cid, kind } = parsed;

  // AU/NZ
  if (region !== 'SP' && region !== 'EX') {
    const channels = region === 'NZ' ? await getNZChannels(kind) : await getChannels(region, kind);
    const ch = channels.get(cid);
    if (!ch) return { streams: [] };
    const streamUrl = ch.url || '';
    const isHLS = /m3u8/i.test(streamUrl);
    if (!isHLS) return { streams: [{ name:'Direct Stream', url:streamUrl, behaviorHints:{ notWebReady:false } }] };
    return { streams: [{
      name:'HLS Stream', url:streamUrl, description:'Direct HLS stream',
      behaviorHints:{ notWebReady:false, bingeGroup:'hls-direct' }
    }] };
  }

  // Curated or Extras
  let ch = null;

  if (region === 'SP') {
    // Sports/EPL tokens expire fast – force refresh
    const force = /(sports|epl)/i.test(parsed.curatedKey);
    const group = await getCuratedGroup(parsed.curatedKey, { forceFresh: force });
    ch = group.get(cid);
  } else {
    // EXTRAS: always force-fresh (SHORT_TTL)
    const g = (await getExtrasGroups({ forceFresh: true })).get(parsed.extrasSlug);
    ch = g?.channels.get(cid);
  }
  if (!ch) return { streams: [] };

  const variants = Array.isArray(ch.variants) && ch.variants.length ? ch.variants : [{ label:'Play', url: ch.url }];

  const streams = [];
  const seen = new Set();
  for (const v of variants) {
    if (!v?.url) continue;
    const direct = String(v.url).trim();
    if (seen.has(direct)) continue;
    seen.add(direct);
    streams.push({
      url: direct,
      title: v.label || 'Stream',
      behaviorHints: { notWebReady: false, bingeGroup: region === 'SP' ? 'curated' : 'extras' },
      proxyHeaders: { request: buildHeaders(direct) }
    });
  }

  if (!streams.length && ch.url) {
    const key = region === 'SP' ? parsed.curatedKey : `ex:${parsed.extrasSlug}`;
    streams.push({ url: curatedRedirectUrl({ curatedKey: key, cid, label:'Play' }), title: 'Play (fallback)' });
  }
  return { streams };
});

/* --------------------- Redirect (tokens) ------------------ */
app.get('/redir/:curatedKey/:cid.m3u8', async (req, res) => {
  try {
    const { curatedKey, cid } = req.params;

    let target = null;
    if (curatedKey.startsWith('ex:')) {
      const slug = curatedKey.slice(3);
      const groups = await getExtrasGroups({ forceFresh: true });
      const g = groups.get(slug);
      target = g?.channels.get(cid)?.url || null;
    } else {
      const force = /(sports|epl)/i.test(curatedKey);
      const group = await getCuratedGroup(curatedKey, { forceFresh: force });
      target = group.get(cid)?.url || null;
    }

    if (!target) return res.status(404).send('Channel not found');

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store, max-age=0');
    res.redirect(302, target);
  } catch (e) {
    res.status(502).send('Media redirect error');
  }
});

/* ---------------------- EXPRESS ROUTES -------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/stats', (_req, res) => res.json({ installs: _memStats.installs || 0 }));

// static assets (public/)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// logo & favicon
app.get(['/AUIPTVLOGO.svg','/favicon.svg'], (_req, res) => {
  const p = path.join(__dirname, 'AUIPTVLOGO.svg');
  if (fs.existsSync(p)) return res.type('image/svg+xml').sendFile(p);
  return res.status(404).end();
});
app.get('/favicon.ico', (_req, res) => res.redirect(302, '/AUIPTVLOGO.svg'));

// extras groups for UI
app.get('/extras/groups', async (_req, res) => {
  try {
    const groups = await getExtrasGroups({ forceFresh: false });
    const arr = [];
    for (const [, g] of groups) arr.push({ slug: g.slug, name: g.name, count: (g.channels?.size || 0) });
    res.json({ groups: arr });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'failed' });
  }
});

// Helper base URL
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}
function parseFlagsFromPath(reqPath) {
  const parts = reqPath.split('/').filter(Boolean);
  const flags = new Set(parts.slice(1));
  if (flags.has('sports')) ['uksports','ussports','casports','ausports','nzsports','eusports','worldsports','epl'].forEach(f=>flags.add(f));
  return { regionRaw: decodeURIComponent(parts[0] || DEFAULT_REGION), flags };
}

/* ----------------------- Manifest endpoints ---------------- */
function buildGenresFromFlags(region, flags, extrasList = []) {
  const opts = ['Traditional Channels','Other Channels','All TV Channels','Regional Channels','Radio'];

  // AU city shortcuts
  REGIONS.filter(r => r !== region).forEach(city => opts.push(`${city} TV`));

  // standard curated/NZ
  opts.push('NZ TV','NZ Radio','UK TV','UK Sports','US TV','US Sports','CA TV','CA Sports','AU Sports','NZ Sports','EU Sports','World Sports','EPL');

  // extras groups shown as "Extra: Name"
  for (const g of extrasList) opts.push(`Extra: ${g.name}`);
  return opts;
}

app.get(/^\/[^/]+(?:\/[^/]+)*\/manifest\.json$/, async (req, res) => {
  try {
    markInstall();
    const { regionRaw, flags } = parseFlagsFromPath(req.path);
    const region = validRegion(regionRaw);

    // extras names (for UI)
    let extrasList = [];
    if (flags.has('extras')) {
      try {
        const groups = await getExtrasGroups({ forceFresh: false });
        extrasList = [...groups.values()].map(g => ({ slug: g.slug, name: g.name }));
      } catch {}
    }

    const man = buildManifestV3(region, buildGenresFromFlags(region, flags, extrasList));
    man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
    if (STREMIO_ADDONS_CONFIG.signature) man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;

    res.json(man);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// legacy simple manifests
app.get('/:region/manifest.json', (req, res) => {
  const region = validRegion(req.params.region);
  const man = buildManifestV3(region, buildGenresFromFlags(region, new Set(), []));
  man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
  if (STREMIO_ADDONS_CONFIG.signature) man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
  res.json(man);
});

// Serve index.html (fallback if missing)
app.get('/', (req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('text/plain').send('UI not packaged. Place your index.html in /public.');
});

/* ----------------------- SDK Router ----------------------- */
const sdkRouter = getRouter(builder.getInterface());
app.use((req, _res, next) => {
  // Strip any path prefix before /catalog|/meta|/stream for Lambda behind base path
  const targets = ['/catalog/','/meta/','/stream/'];
  let idx = -1;
  for (const t of targets) { const i = req.url.indexOf(t); if (i >= 0) idx = (idx === -1 ? i : Math.min(idx, i)); }
  if (idx > 0) req.url = req.url.slice(idx);
  next();
});
app.use('/', sdkRouter);

/* ------------------- Export / Local run ------------------- */
module.exports.handler = serverless(app);

 if (require.main === module) {
   const PORT = process.env.PORT || 7000;
   app.listen(PORT, () => console.log('Listening on', PORT));
 }
