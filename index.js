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

const base = (region) => `https://i.mjh.nz/au/${encodeURIComponent(region)}`;
const tvJsonUrl    = (region) => `${base(region)}/tv.json`;
const radioJsonUrl = (region) => `${base(region)}/radio.json`;
const m3uUrl       = (region) => `${base(region)}/raw-tv.m3u8`;
const radioM3uUrl  = (region) => `${base(region)}/raw-radio.m3u8`;
const epgUrl       = (region) => `${base(region)}/epg.xml`;
const logoUrl      = (region, id) => `${base(region)}/logo/${encodeURIComponent(id)}.png`;

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

function logo(region, ch) {
  if (ch.logo && /^https?:\/\//i.test(ch.logo)) return ch.logo;
  return logoUrl(region, ch.id);
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
  const tz = REGION_TZ[region] || 'Australia/Sydney';
  const searchLc = (extra?.search || '').toLowerCase();
  const selectedGenre = extra?.genre || 'Traditional Channels';

  // Determine content type and region based on genre selection
  let contentRegion = region;
  let contentKind = 'tv';
  let catalogType = 'traditional';
  
  // Parse genre selection
  if (selectedGenre === 'Traditional Channels') {
    catalogType = 'traditional';
  } else if (selectedGenre === 'Other Channels') {
    catalogType = 'other';
  } else if (selectedGenre === 'All TV Channels') {
    catalogType = 'all';
  } else if (selectedGenre === 'Regional Channels') {
    catalogType = 'regional';
  } else if (selectedGenre === 'Radio') {
    contentKind = 'radio';
  } else if (selectedGenre.endsWith(' TV')) {
    // Other city TV
    const cityName = selectedGenre.replace(' TV', '');
    if (REGIONS.includes(cityName)) {
      contentRegion = cityName;
      catalogType = 'all';
    }
  }

  const channels = await getChannels(contentRegion, contentKind);
  const epg = (contentKind === 'tv') ? await getEPG(contentRegion) : new Map();

  const metas = [];
  const channelList = Array.from(channels.entries());

  for (const [cid, ch] of channelList) {
    if (contentKind === 'tv') {
      const isTraditional = isTraditionalChannel(ch.name);
      const isOther = isOtherChannel(ch.name);
      const isRegional = isRegionalChannel(ch.name, contentRegion);
      
      // Filter based on catalog type
      let includeChannel = false;
      switch (catalogType) {
        case 'traditional':
          includeChannel = isTraditional && !isRegional;
          break;
        case 'other':
          includeChannel = (isOther || (!isTraditional && !isRegional)) && !isRegional;
          break;
        case 'all':
          includeChannel = !isRegional;
          break;
        case 'regional':
          includeChannel = isRegional;
          break;
        default:
          includeChannel = true;
      }
      
      if (!includeChannel) continue;
      if (searchLc && !ch.name.toLowerCase().includes(searchLc)) continue;
      
      const list = epg.get(cid) || [];
      const nowp = nowProgramme(list);
      const release = nowp ? `${fmtLocal(nowp.start, tz)} | ${nowp.title}` : (list[0] ? `${fmtLocal(list[0].start, tz)} | ${list[0].title}` : 'Live TV');
      const desc = list.slice(0,4).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
      
      metas.push({
        id: `au|${contentRegion}|${cid}|tv`,
        type: 'tv',
        name: ch.name,
        poster: logo(contentRegion, ch),
        releaseInfo: release,
        description: desc || 'Live television streaming',
        _sortOrder: isTraditional ? getTraditionalChannelOrder(ch.name) : 9999
      });
    } else {
      // Radio channels
      if (searchLc && !ch.name.toLowerCase().includes(searchLc)) continue;
      metas.push({
        id: `au|${contentRegion}|${cid}|radio`,
        type: 'tv',
        name: ch.name,
        poster: logo(contentRegion, ch),
        releaseInfo: 'Live Radio',
        description: 'Live radio streaming',
        _sortOrder: 9999
      });
    }
  }
  
  // Sort channels
  if (catalogType === 'traditional' || catalogType === 'all') {
    // Traditional order for main catalogs
    metas.sort((a, b) => {
      if (a._sortOrder !== b._sortOrder) return a._sortOrder - b._sortOrder;
      return a.name.localeCompare(b.name);
    });
  } else {
    // Alphabetical for other catalogs
    metas.sort((a, b) => a.name.localeCompare(b.name));
  }
  
  // Remove sort order property
  metas.forEach(meta => delete meta._sortOrder);
  
  return { metas };
});

function parseItemId(id) {
  const p = String(id||'').split('|');
  if (p.length < 3 || p[0] !== 'au') return null;
  const [, region, cid, kind = 'tv'] = p;
  return { region: validRegion(region), cid, kind: (kind === 'radio' ? 'radio' : 'tv') };
}

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv') return { meta: {} };
  const parsed = parseItemId(id);
  if (!parsed) return { meta: {} };
  const { region, cid, kind } = parsed;

  const tz = REGION_TZ[region] || 'Australia/Sydney';
  const channels = await getChannels(region, kind);
  const ch = channels.get(cid);
  if (!ch) return { meta: {} };

  if (kind === 'tv') {
    const progs = (await getEPG(region)).get(cid) || [];
    const desc = progs.slice(0,8).map(p => `${fmtLocal(p.start, tz)} | ${p.title || ''}`).join(' • ');
    const nowp = nowProgramme(progs);
    
    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: logo(region, ch),
        description: desc || 'Live television streaming',
        releaseInfo: nowp ? `${fmtLocal(nowp.start, tz)} - ${fmtLocal(nowp.stop, tz)} | ${nowp.title}` : 'Live TV',
      }
    };
  } else {
    return {
      meta: {
        id, type: 'tv', name: ch.name,
        poster: logo(region, ch),
        description: 'Live radio streaming',
        releaseInfo: 'Live Radio',
      }
    };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv') return { streams: [] };
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const { region, cid, kind } = parsed;

  const channels = await getChannels(region, kind);
  const ch = channels.get(cid);
  if (!ch) return { streams: [] };
  return { streams: [{ url: ch.url, title: 'Play' }] };
});

/* ----------------------- LANDING PAGE --------------------- */
const CONFIG_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AU IPTV Add-on</title><meta http-equiv="Cache-Control" content="no-store"/>
<style>
:root{color-scheme:dark;--bg:#0b0c0f;--card:#14161a;--muted:#9aa4b2;--text:#ecf2ff;--ok:#34c759;--okText:#04210d;--line:#22252b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
.wrap{display:grid;place-items:center;padding:28px}.card{width:min(880px,92vw);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
h1{margin:0 0 6px;font-size:26px}.lead{margin:0 0 14px;color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
label{font-size:13px;color:var(--muted)}select{background:#0f1115;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:#101318;color:var(--text);text-decoration:none;cursor:pointer}
.btn:hover{background:#0e1218}.btn-primary{background:var(--ok);border-color:var(--ok);color:var(--okText);font-weight:700}
code{display:block;margin-top:10px;padding:10px 12px;background:#0f1115;border:1px solid var(--line);border-radius:10px;color:#a7f3d0;overflow:auto;word-break:break-all;font-size:12px}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.catalogs{margin:16px 0;padding:12px;background:#0f1115;border:1px solid var(--line);border-radius:10px}
.catalogs h3{margin:0 0 8px;font-size:14px;color:var(--text)}
.catalogs ul{margin:0;padding-left:18px;font-size:13px;color:var(--muted)}
.catalogs li{margin:2px 0}
.catalogs strong{color:var(--text)}
.new-feature{background:#1a2332;border:1px solid #2a4a5a;border-radius:8px;padding:10px;margin:12px 0}
.new-feature h4{margin:0 0 6px;color:#4fc3f7;font-size:13px}
.new-feature p{margin:0;font-size:12px;color:var(--muted)}
</style></head><body>
<div class="wrap"><div class="card">
  <h1>AU IPTV Add-on</h1>
  <p class="lead">Choose your main city, then install. Use the Genre filter in Stremio to access different content types and other cities.</p>

  <div class="new-feature">
    <h4>🎉 NEW: Organized Genre Filtering</h4>
    <p>All channel types and other cities are now accessible through the Genre dropdown in Stremio - no more cluttered addon selection!</p>
  </div>

  <div class="row">
    <label for="region">Main City</label>
    <select id="region">
      <option>Adelaide</option><option selected>Brisbane</option><option>Canberra</option><option>Darwin</option>
      <option>Hobart</option><option>Melbourne</option><option>Perth</option><option>Sydney</option>
    </select>
  </div>
  <div class="row">
    <label><input type="checkbox" id="radio" checked> Include Radio</label>
  </div>

  <div class="catalogs">
    <h3>Available Content (accessed via Genre filter in Stremio):</h3>
    <ul>
      <li><strong>Traditional Channels</strong> - ABC, SBS, NITV, Seven, Nine, Ten (default view)</li>
      <li><strong>Other Channels</strong> - ABC Business, SBS Arabic, specialty channels</li>
      <li><strong>All TV Channels</strong> - Traditional + Other channels combined</li>
      <li><strong>Regional Channels</strong> - Local/regional channels for your city area</li>
      <li><strong>Radio</strong> - Radio stations (if enabled)</li>
      <li><strong>[City] TV</strong> - TV channels from other Australian cities</li>
    </ul>
  </div>

  <div class="row">
    <button id="open" class="btn btn-primary">Open in Stremio Web</button>
    <a id="manifestLink" class="btn" href="#" target="_blank" rel="noopener">Open manifest.json</a>
  </div>

  <code id="preview">—</code>
  <div class="hint">Web installer: <span id="weburl">—</span></div>
</div></div>

<script>
const $ = s => document.querySelector(s);
function region() { return encodeURIComponent(($('#region').value||'Brisbane').trim()); }
function pathPrefix() {
  const parts = [region()];
  if ($('#radio').checked) parts.push('radio');
  return '/' + parts.join('/');
}
function manifestUrl() { return location.origin + pathPrefix() + '/manifest.json'; }
function webInstall(u) { return 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(u); }
function update() {
  const m = manifestUrl(); const w = webInstall(m);
  $('#preview').textContent = m; $('#weburl').textContent = w; $('#manifestLink').href = m;
}
$('#region').addEventListener('change', update);
$('#radio').addEventListener('change', update);
$('#open').addEventListener('click', () => window.open(webInstall(manifestUrl()), '_blank', 'noopener,noreferrer'));
document.addEventListener('DOMContentLoaded', update);
</script>
</body></html>`;

/* ----------------------- EXPRESS ROUTES ------------------- */
// CORS & no-store
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

// Health
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Landing page
app.get('/', (_req, res) => res.type('html').send(CONFIG_HTML));

// Dynamic manifest routes
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

// Fallback: plain /manifest.json -> default region, radio ON
app.get('/manifest.json', (_req, res) => res.json(buildManifest(DEFAULT_REGION, true)));

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