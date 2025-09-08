// index.js — AU IPTV + NZ + Curated (A1X & Extra Pack) — v2.7.0 (fixed order)
const express = require('express');
const serverless = require('serverless-http');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');
const { Readable } = require('node:stream');

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

// Optional signature
const STREMIO_ADDONS_CONFIG = {
  issuer: 'https://stremio-addons.net',
  signature: process.env.STREMIO_ADDONS_SIGNATURE
    || 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..jPqqSM-s0k525D13Y_oqXA.Hz3vTlruk-WxtkneysiM4Eq9sAuCSNcW_77QHAdRFocIAbom2Ju8lhwpSI0W8aEtMeqefAV4i46N7Z5452wqPfJZZHzJ9OVcDtDTqaGxi33Znt68CD8oZqQOalnRrC2x.qR2mVkk9v112anUUgUoFCQ'
};

// Posters map (GitHub /images)
const IMAGES_BASE = process.env.IMAGES_BASE || 'https://raw.githubusercontent.com/josharghhh/AU-IPTV_StremioAddon/main';
let POSTER_MAP = {};
try { POSTER_MAP = require('./map.json'); } catch {}

/* ------------------------- CURATED SOURCES ------------------------- */
// A1X (primary curated)
const A1X_CURATED_PRIMARY = 'https://bit.ly/a1xstream';
const A1X_CURATED_BACKUP  = 'https://a1xs.vip/a1xstream';
const A1X_CURATED_DIRECT  = 'https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u';
const A1X_EPG_URL         = 'https://bit.ly/a1xepg';
const UK_SPORTS_FALLBACK  = 'https://forgejo.plainrock127.xyz/Mystique-Play/Mystique/raw/branch/main/countries/uk_sports.m3u';

// Extra Pack (your gist)
const EXTRA_M3U_URL = process.env.EXTRA_M3U_URL
  || 'https://gist.githubusercontent.com/One800burner/dae77ddddc1b83d3a4d7b34d2bd96a5e/raw/1roguevip.m3u';

/* ------------------------- STATS / CACHE -------------------------- */
const STATS_SEED = Number(process.env.STATS_SEED || 498);
let _memStats = { installs: STATS_SEED };

const CACHE_TTL = 15 * 60 * 1000;
const cache = {
  m3u: new Map(), epg: new Map(),
  radioM3u: new Map(),
  a1x: new Map(),
  nz_tv_m3u: new Map(), nz_radio_m3u: new Map(), nz_epg: new Map(),
  extra: new Map()
};
const fresh = (entry) => entry && (Date.now() - entry.ts) < CACHE_TTL;
const validRegion = (r) => (REGIONS.includes(r) ? r : DEFAULT_REGION);

/* ----------------------------- UTILS ------------------------------ */
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
  if (String(regionOrKey || '').startsWith('SP')) return '';
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}
function m3uLogoAny(regionOrKey, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  if (regionOrKey === 'NZ') return `${baseNZ()}/logo/${encodeURIComponent(ch.id)}.png`;
  if (String(regionOrKey || '').startsWith('SP')) return '';
  return `${base(regionOrKey)}/logo/${encodeURIComponent(ch.id)}.png`;
}
function markInstall() { _memStats.installs = (_memStats.installs || 0) + 1; }

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

/* --------------------------- QUALITIES ---------------------------- */
const norm = (s='') => String(s||'').toLowerCase();
const isUHD = (n='', u='') => /\b(uhd|4k|2160p?)\b/.test(norm(n)) || /(2160|uhd|4k|hevc|main10|h\.?265)/.test(norm(u));
const isFHD = (n='', u='') => /\b(fhd|1080p?)\b/.test(norm(n+' '+u)) || /(?:^|[^0-9])1080(?:[^0-9]|$)/.test(norm(n+' '+u));
const isHD  = (n='', u='') => /\bhd\b/.test(norm(n+' '+u)) || /\b720p?\b/.test(norm(n+' '+u)) || /(?:^|[^0-9])720(?:[^0-9]|$)/.test(norm(n+' '+u));
const qualityLabel = (n='', u='') => isUHD(n,u) ? 'UHD / 4K' : isFHD(n,u) ? 'FHD / 1080p' : isHD(n,u) ? 'HD / 720p' : 'SD';
const baseNameClean = (name='') => String(name)
  .replace(/^\s*(?:UKI?\s*\|\s*|\[[^\]]+\]\s*)/i, '')
  .replace(/\b(UHD|4K|2160p?|FHD|1080p|HD|720p|SD)\b/ig, '')
  .replace(/\s{2,}/g, ' ')
  .trim();
const slugify = (s='') => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,'');

/* ------------------------------ EPG/TIME -------------------------- */
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
    const off = s.slice(15), sign = off[0] === '-' ? -1 : 1;
    const offMin = sign * (parseInt(off.slice(1,3))*60 + parseInt(off.slice(3,5)));
    return new Date(Date.UTC(y,mo,d,h,m,sec) - offMin*60000);
  }
  const d = new Date(s); return isNaN(d) ? new Date() : d;
}
const fmtLocal = (s, tz) => {
  const d = parseTime(s);
  try { return new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d); }
  catch { const hh=d.getHours()%12||12, mm=`${d.getMinutes()}`.padStart(2,'0'), ap=d.getHours()>=12?'pm':'am'; return `${hh}:${mm}${ap}`; }
};
function nowProgramme(list) {
  const now = Date.now();
  for (const p of list || []) {
    const s = parseTime(p.start).getTime(), e = parseTime(p.stop).getTime();
    if (!Number.isNaN(s) && !Number.isNaN(e) && s <= now && now < e) return p;
  }
  return null;
}

/* ------------------------------ SOURCES --------------------------- */
// AU
const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;
// NZ
const baseNZ       = () => `https://i.mjh.nz/nz`;
const m3uUrlNZ     = () => `${baseNZ()}/raw-tv.m3u8`;
const radioM3uUrlNZ= () => `${baseNZ()}/raw-radio.m3u8`;
const epgUrlNZ     = () => `${baseNZ()}/epg.xml`;

/* ----------------------- CURATED (A1X) ---------------------------- */
const curatedKeyMatchEntry = (key, e) => {
  const g = e.group || '', n = e.name || '';
  const inAny = (hay, needles) => {
    const H = String(hay).toLowerCase(); return needles.some(x => H.includes(String(x).toLowerCase()));
  };
  const isSports = /\bsport(s)?\b/i.test(g);
  switch (key) {
    case 'uk_tv':        return inAny(g,['UK','United Kingdom']) && !isSports;
    case 'us_tv':        return inAny(g,['US','USA','United States']) && !isSports;
    case 'ca_tv':        return inAny(g,['CA','Canada']) && !isSports;
    case 'uk_sports':    return inAny(g,['UK','United Kingdom']) && isSports;
    case 'us_sports':    return inAny(g,['US','USA','United States']) && isSports;
    case 'ca_sports':    return inAny(g,['CA','Canada']) && isSports;
    case 'au_sports':    return inAny(g,['AU','Australia']) && isSports;
    case 'nz_sports':    return inAny(g,['NZ','New Zealand']) && isSports;
    case 'eu_sports':    return inAny(g,['EU','Europe','European']) && isSports;
    case 'world_sports': return inAny(g,['World','International','Global']) && isSports;
    case 'epl':          return /\bEPL\b|\bPremier League\b/i.test(n) || /\bPremier\b.*\bLeague\b/i.test(g);
    default:             return false;
  }
};

async function fetchCuratedM3U() {
  const C = cache.a1x.get('curated_text');
  if (C && fresh(C)) return C.text;
  const headers = { 'User-Agent': 'Mozilla/5.0 (AUIPTV-Addon)' };
  let text = '';
  for (const src of [A1X_CURATED_PRIMARY, A1X_CURATED_BACKUP, A1X_CURATED_DIRECT]) {
    try {
      const r = await fetch(src, { redirect: 'follow', headers }); if (!r.ok) throw new Error(r.status);
      text = await r.text(); if (text && text.length > 100) break;
    } catch {}
  }
  cache.a1x.set('curated_text', { ts: Date.now(), text: text || '' });
  return text || '';
}
async function fetchCuratedEntries() {
  const C = cache.a1x.get('curated_entries');
  if (C && fresh(C)) return C.entries;
  const entries = parseM3UEntries(await fetchCuratedM3U());
  cache.a1x.set('curated_entries', { ts: Date.now(), entries });
  return entries;
}

/**
 * getCuratedGroup(key) => Map(id -> {id,name,logo,url,variants,abr})
 */
async function getCuratedGroup(key) {
  const ck = `group:${key}:v3`;
  const C = cache.a1x.get(ck);
  if (C && fresh(C)) return C.channels;

  let channels = new Map();
  try {
    const entries = await fetchCuratedEntries();
    const grouped = new Map();

    for (const e of entries) {
      if (!curatedKeyMatchEntry(key, e)) continue;
      const base = baseNameClean(e.name);
      const label = qualityLabel(e.name, e.url);
      const rankMap = { 'FHD / 1080p':3, 'HD / 720p':2, 'UHD / 4K':1, 'SD':0 };
      const rank = rankMap[label] ?? 0;

      if (!grouped.has(base)) grouped.set(base, { id: e.id || base, name: base, logo: e.logo || null, variants: [], abr: null });
      const g = grouped.get(base);

      const isMaster = /master\.m3u8|index\.m3u8/i.test(e.url) || /abr|auto|master|index/i.test(e.name || '');
      if (isMaster && !g.abr) g.abr = e.url;

      const idx = g.variants.findIndex(v => v.label === label);
      const preferA1 = /a1xs?\.vip/i.test(e.url);
      if (idx >= 0) {
        const ex = g.variants[idx];
        if (preferA1 && !/a1xs?\.vip/i.test(ex.url)) g.variants[idx] = { label, url: e.url, rank };
      } else {
        g.variants.push({ label, url: e.url, rank });
      }
      if (!g.logo && e.logo) g.logo = e.logo;
    }

    channels = new Map();
    for (const [_, obj] of grouped) {
      obj.variants.sort((a,b) => b.rank - a.rank);
      obj.url = (obj.variants.find(v => v.label.includes('FHD'))?.url) || obj.variants[0]?.url || obj.abr || null;
      const id = obj.id || obj.name;
      channels.set(id, { id, name: obj.name, logo: obj.logo, url: obj.url, variants: obj.variants, abr: obj.abr });
    }
  } catch {}

  if ((!channels || channels.size === 0) && key === 'uk_sports') {
    try {
      const text = await (await fetch(UK_SPORTS_FALLBACK, { cache: 'no-store' })).text();
      const entries = parseM3UEntries(text);
      const grouped = new Map();
      for (const e of entries) {
        const base = baseNameClean(e.name);
        const label = qualityLabel(e.name, e.url);
        const rankMap = { 'FHD / 1080p':3, 'HD / 720p':2, 'UHD / 4K':1, 'SD':0 };
        const rank = rankMap[label] ?? 0;
        if (!grouped.has(base)) grouped.set(base, { id: e.id || base, name: base, logo: e.logo || null, variants: [] });
        const g = grouped.get(base);
        if (!g.variants.some(v => v.label === label)) g.variants.push({ label, url: e.url, rank });
        if (!g.logo && e.logo) g.logo = e.logo;
      }
      channels = new Map();
      for (const [, obj] of grouped) {
        obj.variants.sort((a,b) => b.rank - a.rank);
        const id = obj.id || obj.name;
        channels.set(id, { id, name: obj.name, logo: obj.logo, url: obj.variants[0]?.url || null, variants: obj.variants });
      }
    } catch {}
  }

  cache.a1x.set(ck, { ts: Date.now(), channels });
  return channels;
}

/* ----------------------- EXTRA PACK -------------------- */
async function fetchExtraEntries() {
  const C = cache.extra.get('entries');
  if (C && fresh(C)) return C.entries;
  let text = '';
  try {
    const r = await fetch(EXTRA_M3U_URL, { redirect: 'follow', cache: 'no-store' });
    if (r.ok) text = await r.text();
  } catch {}
  const entries = parseM3UEntries(text);
  cache.extra.set('entries', { ts: Date.now(), entries });
  return entries;
}
async function getExtraGroups() {
  const entries = await fetchExtraEntries();
  const counts = new Map();
  for (const e of entries) {
    const g = (e.group || 'Other').trim();
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const groups = [...counts.keys()].sort((a,b)=>a.localeCompare(b)).map(name => ({ name, slug: slugify(name), count: counts.get(name) }));
  return groups;
}
async function getExtraChannels(filterGroupName = null) {
  const key = `extra:channels:${filterGroupName || 'ALL'}`;
  const C = cache.extra.get(key);
  if (C && fresh(C)) return C.channels;

  const entries = await fetchExtraEntries();
  const grouped = new Map();
  for (const e of entries) {
    if (filterGroupName && String(e.group || '').trim() !== filterGroupName) continue;
    const base = baseNameClean(e.name);
    const label = qualityLabel(e.name, e.url);
    const rankMap = { 'FHD / 1080p':3, 'HD / 720p':2, 'UHD / 4K':1, 'SD':0 };
    const rank = rankMap[label] ?? 0;

    if (!grouped.has(base)) grouped.set(base, { id: e.id || base, name: base, logo: e.logo || null, variants: [], abr: null });
    const g = grouped.get(base);

    const isMaster = /master\.m3u8|index\.m3u8/i.test(e.url) || /abr|auto|master|index/i.test(e.name || '');
    if (isMaster && !g.abr) g.abr = e.url;

    const idx = g.variants.findIndex(v => v.label === label);
    if (idx >= 0) g.variants[idx] = { label, url: e.url, rank };
    else g.variants.push({ label, url: e.url, rank });

    if (!g.logo && e.logo) g.logo = e.logo;
  }

  const channels = new Map();
  for (const [, obj] of grouped) {
    obj.variants.sort((a,b) => b.rank - a.rank);
    obj.url = (obj.variants.find(v => v.label.includes('FHD'))?.url) || obj.variants[0]?.url || obj.abr || null;
    channels.set(obj.id || obj.name, obj);
  }

  cache.extra.set(key, { ts: Date.now(), channels });
  return channels;
}

/* -------------------- AU/NZ FETCHERS ------------------ */
async function getChannels(region, kind = 'tv') {
  if (kind === 'radio') {
    const key = `${region}:radio_m3u`, C = cache.radioM3u.get(key);
    if (C && fresh(C)) return C.channels;
    let channels = new Map();
    try { const text = await (await fetch(radioM3uUrl(region))).text(); channels = parseM3U(text); } catch {}
    cache.radioM3u.set(key, { ts: Date.now(), channels }); return channels;
  }
  const key = `${region}:m3u`, C = cache.m3u.get(key);
  if (C && fresh(C)) return C.channels;
  const text = await (await fetch(m3uUrl(region))).text();
  const channels = parseM3U(text);
  cache.m3u.set(key, { ts: Date.now(), channels }); return channels;
}
async function getEPG(region) {
  const key = `${region}:epg`, C = cache.epg.get(key);
  if (C && fresh(C)) return C.map;
  const xml = await (await fetch(epgUrl(region))).text();
  const map = await parseEPG(xml);
  cache.epg.set(key, { ts: Date.now(), map }); return map;
}
async function getNZChannels(kind='tv') {
  if (kind === 'radio') {
    const C = cache.nz_radio_m3u.get('nz'); if (C && fresh(C)) return C.channels;
    let channels = new Map(); try { const text = await (await fetch(radioM3uUrlNZ())).text(); channels = parseM3U(text); } catch {}
    cache.nz_radio_m3u.set('nz', { ts: Date.now(), channels }); return channels;
  }
  const C = cache.nz_tv_m3u.get('nz'); if (C && fresh(C)) return C.channels;
  let channels = new Map(); try { const text = await (await fetch(m3uUrlNZ())).text(); channels = parseM3U(text); } catch {}
  cache.nz_tv_m3u.set('nz', { ts: Date.now(), channels }); return channels;
}
async function getNZEPG() {
  const C = cache.nz_epg.get('nz'); if (C && fresh(C)) return C.map;
  const xml = await (await fetch(epgUrlNZ())).text();
  const map = await parseEPG(xml); cache.nz_epg.set('nz', { ts: Date.now(), map }); return map;
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
function buildManifestV3(selectedRegion, options) {
  const {
    auTV = true, radio = true,
    nzTV = false, nzRadio = false, nzDefault = false,
    uktv = false, uksports = false, ustv = false, ussports = false, catv = false, casports = false,
    ausports = false, nzsports = false, eusports = false, worldsports = false, epl = false,
    extras = false, extraGroupNames = []
  } = options || {};

  const catalogs = [];
  const genreOptions = [];

  if (auTV) genreOptions.push('Traditional Channels','Other Channels','All TV Channels','Regional Channels');
  if (radio) genreOptions.push('Radio');

  if (auTV) REGIONS.filter(r => r !== selectedRegion).forEach(city => genreOptions.push(`${city} TV`));
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

  if (extras) {
    genreOptions.push('Extra Pack');
    extraGroupNames.forEach(n => genreOptions.push(`Extra: ${n}`));
  }

  let isRequired = !!nzDefault;
  if (nzDefault && nzTV) {
    const pruned = genreOptions.filter(g => g !== 'NZ TV');
    genreOptions.length = 0; genreOptions.push('NZ TV', ...pruned);
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
    version: '2.7.0',
    name: `AU IPTV (${displayName})`,
    description: 'AU + NZ live TV & radio with curated international packs.',
    types: ['tv'], catalogs, resources: ['catalog','meta','stream']
  };
}

/* ---------------------- ADDON BUILDER --------------------- */
const builder = new addonBuilder(buildManifestV3(DEFAULT_REGION, { auTV: true, radio: true }));

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

  let contentRegion = region;
  let contentKind   = 'tv';
  let catalogType   = 'traditional';
  let isNZ          = false;

  let isCurated     = false;
  let curatedKey    = null;
  let extraFilterGroup = null;

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
  } else if (genreIs(selectedGenre, 'extra pack','extra','extras')) {
    isCurated = true; curatedKey = 'ex';
  } else if (/^extra:\s*(.+)$/i.test(selectedGenre)) {
    isCurated = true; curatedKey = 'ex'; extraFilterGroup = selectedGenre.replace(/^extra:\s*/i,'').trim();
  } else if (genreIs(selectedGenre, 'uk tv','uk channels'))                 { isCurated = true; curatedKey = 'uk_tv'; }
    else if (genreIs(selectedGenre, 'uk sports','uk sport'))                { isCurated = true; curatedKey = 'uk_sports'; }
    else if (genreIs(selectedGenre, 'us tv','us channels','usa tv'))        { isCurated = true; curatedKey = 'us_tv'; }
    else if (genreIs(selectedGenre, 'us sports','usa sports'))              { isCurated = true; curatedKey = 'us_sports'; }
    else if (genreIs(selectedGenre, 'ca tv','canada tv','ca channels'))     { isCurated = true; curatedKey = 'ca_tv'; }
    else if (genreIs(selectedGenre, 'ca sports','canada sports'))           { isCurated = true; curatedKey = 'ca_sports'; }
    else if (genreIs(selectedGenre, 'au sports'))                           { isCurated = true; curatedKey = 'au_sports'; }
    else if (genreIs(selectedGenre, 'nz sports'))                           { isCurated = true; curatedKey = 'nz_sports'; }
    else if (genreIs(selectedGenre, 'eu sports'))                           { isCurated = true; curatedKey = 'eu_sports'; }
    else if (genreIs(selectedGenre, 'world sports'))                        { isCurated = true; curatedKey = 'world_sports'; }
    else if (genreIs(selectedGenre, 'epl'))                                 { isCurated = true; curatedKey = 'epl'; }
  else {
    const cityName = genreCity(selectedGenre);
    if (cityName) { contentRegion = cityName; catalogType = 'all'; }
  }

  const tz = isNZ ? 'Pacific/Auckland' : (isCurated ? 'UTC' : (REGION_TZ[contentRegion] || 'Australia/Sydney'));

  let channels;
  if (isNZ) channels = await getNZChannels(contentKind);
  else if (isCurated) {
    if (curatedKey === 'ex') channels = await getExtraChannels(extraFilterGroup || null);
    else channels = await getCuratedGroup(curatedKey);
  } else channels = await getChannels(contentRegion, contentKind);

  const epg = (contentKind === 'tv')
    ? (isNZ ? await getNZEPG() : (isCurated ? new Map() : await getEPG(contentRegion)))
    : new Map();

  const metas = [];
  for (const [cid, ch] of channels) {
    if (contentKind === 'tv') {
      let includeChannel = true;
      if (!isNZ && !isCurated) {
        const traditional = /ABC|SBS|SEVEN|7TWO|7MATE|7FLIX|7BRAVO|NINE|9GEM|9GO|9LIFE|9RUSH|TEN|10|BOLD|PEACH|SHAKE|COMEDY|DRAMA|NITV|DUKE/i.test(ch.name);
        const regional = (() => {
          const s = ch.name.toLowerCase(), r = contentRegion.toLowerCase();
          const kws = ['regional','canberra','darwin','hobart','adelaide','perth','brisbane','sydney','melbourne','cairns','mackay','rockhampton','townsville','toowoomba','sunshine coast','gold coast','wide bay','southern cross','win','prime','imparja'];
          if (s.includes(r)) return false; return kws.some(k => s.includes(k));
        })();
        const other = (() => {
          const u = ch.name.toUpperCase();
          if (['ABC BUSINESS','SBS WORLD MOVIES','SBS WORLD WATCH','SBS WORLDWATCH','SBS FOOD','SBS VICELAND'].includes(u)) return true;
          if (/\bHYBPA\b|\bHAVE YOU BEEN PAYING ATTENTION\b/i.test(u)) return true;
          if (/(?:\b8\b|\bEIGHT\b)\s*(?:OUT\s*OF\s*)?\b10\b\s*CATS/i.test(u)) return true;
          return false;
        })();

        if (catalogType === 'traditional')      { includeChannel = traditional && !regional && !other; }
        else if (catalogType === 'other')       { includeChannel = (other || (!traditional && !regional)) && !regional; }
        else if (catalogType === 'regional')    { includeChannel = regional; }
        else                                    { includeChannel = !regional; }
      }
      if (!includeChannel) continue;

      const list = epg.get(cid) || [];
      const nowp = nowProgramme(list);
      const release = nowp ? `${fmtLocal(nowp.start, tz)} | ${nowp.title}`
                           : (list[0] ? `${fmtLocal(list[0].start, tz)} | ${list[0].title}`
                           : (isNZ ? 'Live NZ TV' : (isCurated ? 'Curated TV' : 'Live TV')));

      metas.push({
        id: isCurated
            ? `au|SP:${curatedKey}|${cid}|tv`
            : `au|${isNZ?'NZ':contentRegion}|${cid}|tv`,
        type: 'tv',
        name: ch.name,
        poster: posterAny(isCurated?`SP:${curatedKey}`:(isNZ?'NZ':contentRegion), ch),
        posterShape: 'square',
        description: isNZ ? 'New Zealand TV' : (isCurated ? 'Curated TV' : (catalogType === 'regional' ? 'Regional AU TV' : 'Live AU TV')),
        releaseInfo: release
      });
    } else {
      metas.push({
        id: `au|${isNZ?'NZ':contentRegion}|${cid}|radio`,
        type: 'tv',
        name: ch.name,
        poster: posterAny(isNZ?'NZ':contentRegion, ch),
        posterShape: 'square',
        description: isNZ ? 'New Zealand Radio' : 'Live AU Radio',
        releaseInfo: isNZ ? 'Live NZ Radio' : 'Live Radio'
      });
    }
  }

  metas.sort((a,b) => a.name.localeCompare(b.name));
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
  } else if (region === 'SP') {
    tz = 'UTC';
    channels = (parsed.curatedKey === 'ex') ? await getExtraChannels(null) : await getCuratedGroup(parsed.curatedKey);
  } else {
    tz = REGION_TZ[region] || 'Australia/Sydney';
    channels = await getChannels(region, kind);
  }
  ch = channels.get(cid);
  if (!ch) return { meta: {} };

  const regionKey = region === 'SP' ? `SP:${parsed.curatedKey}` : region;

  if (kind === 'tv') {
    const progs = (region === 'NZ')
      ? ((await getNZEPG()).get(cid) || [])
      : (region === 'SP' ? [] : ((await getEPG(region)).get(cid) || []));
    const desc = progs.slice(0, 8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
    const nowp = nowProgramme(progs);

    const squarePoster = posterAny(regionKey, ch);
    const m3uPoster    = (region === 'SP') ? null : m3uLogoAny(regionKey, ch);

    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: squarePoster,
        background: squarePoster,
        logo: m3uPoster || squarePoster,
        posterShape: 'square',
        description: desc || (region === 'NZ' ? 'Live NZ television' : (region === 'SP' ? 'Curated' : 'Live television streaming')),
        releaseInfo: nowp
          ? `${fmtLocal(nowp.start, tz)} - ${fmtLocal(nowp.stop, tz)} | ${nowp.title}`
          : (region === 'NZ' ? 'Live NZ TV' : (region === 'SP' ? 'Curated TV' : 'Live TV')),
      }
    };
  } else {
    const squarePoster = posterAny(regionKey, ch);
    const m3uPoster    = (region === 'SP') ? null : m3uLogoAny(regionKey, ch);
    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: squarePoster, background: squarePoster, logo: m3uPoster || squarePoster,
        posterShape: 'square', description: region === 'NZ' ? 'Live NZ radio streaming' : 'Live radio streaming',
        releaseInfo: region === 'NZ' ? 'Live NZ Radio' : 'Live Radio',
      }
    };
  }
});

/* ---------------------- HLS PROXY (obfuscates) ------------ */
function getRefererForUrl(url) {
  try { const urlObj = new URL(url); return `${urlObj.protocol}//${urlObj.hostname}/`; }
  catch { return 'https://www.google.com/'; }
}
function getOriginForUrl(url) {
  try { const urlObj = new URL(url); return `${urlObj.protocol}//${urlObj.hostname}`; }
  catch { return 'https://www.google.com'; }
}
function defaultHeadersFor(url) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    'Origin': getOriginForUrl(url),
    'Referer': getRefererForUrl(url),
    'Accept': '*/*',
    'Connection': 'keep-alive'
  };
}
function absResolve(ref, baseUrl) { try { return new URL(ref, baseUrl).toString(); } catch { return ref; } }
let PUBLIC_BASE = process.env.PUBLIC_BASE_URL || null;
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}
app.use((req, _res, next) => {
  try { const b = baseUrl(req); if (b && (!PUBLIC_BASE || PUBLIC_BASE !== b)) PUBLIC_BASE = b; } catch {}
  next();
});
const publicBase = () => PUBLIC_BASE || process.env.PUBLIC_BASE_URL || '';
function proxyUrl(abs) { return `${publicBase()}/hls/p?u=${encodeURIComponent(abs)}`; }
function rewriteAttributeURI(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/gi, (_m, p1) => `URI="${proxyUrl(absResolve(p1, baseUrl))}"`);
}
function rewriteM3U8(body, baseUrl) {
  const out = [];
  const lines = String(body || '').split(/\r?\n/);
  for (const ln of lines) {
    if (!ln || /^\s*$/.test(ln)) { out.push(ln); continue; }
    if (ln.startsWith('#')) { out.push(rewriteAttributeURI(ln, baseUrl)); continue; }
    out.push(proxyUrl(absResolve(ln.trim(), baseUrl)));
  }
  return out.join('\n');
}
app.get('/hls/p', async (req, res) => {
  try {
    const src = String(req.query.u || '');
    if (!/^https?:\/\//i.test(src)) return res.status(400).send('bad url');
    const upstream = await fetch(src, { redirect: 'follow', headers: defaultHeadersFor(src) });

    const ctype = upstream.headers.get('content-type') || '';
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store, max-age=0');

    if (/application\/vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(src)) {
      const text = await upstream.text();
      const rewritten = rewriteM3U8(text, src);
      return res.type('application/vnd.apple.mpegurl').send(rewritten);
    }

    if (ctype) res.set('Content-Type', ctype);
    res.status(upstream.status);

    if (upstream.body) {
      if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(upstream.body).pipe(res);
      if (typeof upstream.body.pipe === 'function') return upstream.body.pipe(res);
      const buf = Buffer.from(await upstream.arrayBuffer()); return res.end(buf);
    }
    return res.end();
  } catch (e) {
    console.error('HLS proxy error:', e.message);
    res.status(502).send('proxy failure');
  }
});

/* ------------------ EXTRAS: GROUPS API (for UI) ----------- */
app.get('/extras/groups', async (_req, res) => {
  try {
    const groups = await getExtraGroups();
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ groups: [] });
  }
});

/* ---------------------- PUBLIC + CORS --------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------------- MANIFEST ROUTES ------------------- */
function parseFlagsFromPath(reqPath) {
  const parts = reqPath.split('/').filter(Boolean);
  const flags = new Set(parts.slice(1)); // after region
  if (flags.has('sports')) ['uksports','ussports','casports','ausports','nzsports','eusports','worldsports','epl'].forEach(f=>flags.add(f));
  if (flags.has('ukskysports') || flags.has('ukskyother')) flags.add('uksports');

  const exGroups = [...flags].filter(f => f.startsWith('exgrp-')).map(s => s.slice('exgrp-'.length));
  return { regionRaw: decodeURIComponent(parts[0] || DEFAULT_REGION), flags, exGroupSlugs: exGroups };
}

app.get(/^\/[^/]+(?:\/[^/]+)*\/manifest\.json$/, async (req, res) => {
  try {
    markInstall();
    const { regionRaw, flags, exGroupSlugs } = parseFlagsFromPath(req.path);
    const region = validRegion(regionRaw);

    let extraGroupNames = [];
    if (flags.has('extras')) {
      const all = await getExtraGroups();
      const map = new Map(all.map(g => [g.slug, g.name]));
      extraGroupNames = exGroupSlugs.map(sl => map.get(sl)).filter(Boolean);
    }

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
      epl: flags.has('epl'),
      extras: flags.has('extras'),
      extraGroupNames
    });

    man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
    man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
    res.json(man);
  } catch (e) {
    console.error('manifest v3 error', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Legacy helpers
app.get('/:region/manifest.json', async (req, res) => {
  const region = validRegion(req.params.region);
  const man = buildManifestV3(region, { auTV: true, radio: false });
  man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
  man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
  res.json(man);
});
app.get('/:region/radio/manifest.json', async (req, res) => {
  const region = validRegion(req.params.region);
  const man = buildManifestV3(region, { auTV: true, radio: true });
  man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
  man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
  res.json(man);
});

app.get('/manifest.json', async (req, res) => {
  const man = buildManifestV3(DEFAULT_REGION, { auTV: true, radio: true });
  man.logo = man.icon = `${baseUrl(req)}/AUIPTVLOGO.svg`;
  man.stremioAddonsConfig = STREMIO_ADDONS_CONFIG;
  res.json(man);
});

/* ---------------------- STREAM HANDLER -------------------- */
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv') return { streams: [] };
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const { region, cid, kind } = parsed;

  let channels;
  if (region === 'NZ') channels = await getNZChannels(kind);
  else if (region === 'SP') {
    channels = (parsed.curatedKey === 'ex') ? await getExtraChannels(null) : await getCuratedGroup(parsed.curatedKey);
  } else channels = await getChannels(region, kind);

  const ch = channels.get(cid);
  if (!ch) return { streams: [] };

  if (region === 'SP' && Array.isArray(ch.variants) && ch.variants.length > 0) {
    const seen = new Set();
    const toLabel = v => v.label || (v.url?.includes('2160') ? 'UHD / 4K' : v.url?.includes('1080') ? 'FHD / 1080p' : v.url?.includes('720') ? 'HD / 720p' : 'SD');
    const streams = [];
    for (const v of ch.variants) {
      if (!v?.url) continue;
      const url = `${publicBase()}/hls/p?u=${encodeURIComponent(v.url)}`;
      if (seen.has(url)) continue;
      seen.add(url);
      streams.push({
        url,
        title: toLabel(v),
        behaviorHints: { notWebReady: false, bingeGroup: 'hls-proxy' }
      });
    }
    if (ch.abr) streams.unshift({
      url: `${publicBase()}/hls/p?u=${encodeURIComponent(ch.abr)}`,
      title: 'Auto (ABR)',
      behaviorHints: { notWebReady: false, bingeGroup: 'hls-proxy' }
    });
    return { streams };
  }

  if (region === 'SP') {
    const url = `${publicBase()}/hls/p?u=${encodeURIComponent(ch.url)}`;
    return { streams: [{ url, title: 'Play', behaviorHints: { notWebReady: false } }] };
  }

  const streamUrl = ch.url || '';
  const isHLS = /m3u8/i.test(streamUrl);
  return {
    streams: [{
      name: isHLS ? '🌐 HLS Stream' : '📺 Direct Stream',
      description: isHLS ? 'Direct HLS stream' : 'Direct stream',
      url: streamUrl,
      behaviorHints: { notWebReady: false }
    }]
  };
});

/* ---------------------- SDK ROUTER (after handlers!) ------ */
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

/* ---------------------- HEALTH / LOGO / STATS -------------- */
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/stats', (_req, res) => res.json({ installs: _memStats.installs || 0 }));
app.get(['/AUIPTVLOGO.svg','/favicon.svg'], (_req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'AUIPTVLOGO.svg')));
app.get('/favicon.ico', (_req, res) => res.redirect(302, '/AUIPTVLOGO.svg'));

/* ---------------------- STARTUP --------------------------- */
module.exports.handler = serverless(app);
if (require.main === module) {
  const PORT = process.env.PORT || 7000;
  app.listen(PORT, () => console.log('Listening on', PORT));
}
