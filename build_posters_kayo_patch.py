#!/usr/bin/env python3
# pip install aiohttp aiofiles pillow tqdm
# optional: pip install cairosvg

import os, re, io, json, zipfile, urllib.parse, base64, csv, time, asyncio, random
import aiohttp, aiofiles
from typing import Dict, Tuple, Iterable, Optional, List
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from tqdm import tqdm

try:
    import cairosvg  # optional SVG->PNG
except Exception:
    cairosvg = None

# ==================== CONFIG ====================
ROOT = os.path.dirname(__file__)
OUT_DIR = os.path.join(ROOT, "images")
SIZE = 1024
PAD = 32
BG_DARK = (24, 24, 24, 255)
BG_LIGHT = (240, 240, 240, 255)

REGIONS = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney']

A1X_SOURCES = (
    "https://bit.ly/a1xstream",
    "https://a1xs.vip/a1xstream",
    "https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u",
)

# Extras sources: env override or default gist
EXTRAS_URLS = (
    os.getenv("EXTRAS_URL") or
    "https://gist.githubusercontent.com/One800burner/dae77ddddc1b83d3a4d7b34d2bd96a5e/raw/1roguevip.m3u"
)
EXTRAS_PATH = os.path.join(ROOT, "extras.m3u")  # optional local fallback

INPUT_MAP_CANDIDATES = [
    os.path.join(ROOT, "map.json"),
    os.path.join(ROOT, "curated.json"),
    os.path.join(ROOT, "curated.map.json"),
]

# Speed knobs
HTTP_TIMEOUT = int(os.getenv("HTTP_TIMEOUT", "60"))  # Increased timeout
MAX_CONCURRENT_REQUESTS = int(os.getenv("MAX_CONC", "64"))
MAX_WORKERS = max(4, (os.cpu_count() or 8) * 2)

# Gentle per-host rate limits (seconds between requests) for picky CDNs
HOST_RATELIMITS = {
    "watch.foxtel.com.au": 1.2,          # 403 if hammered / no referer
    "imageresizer.static9.net.au": 0.6,  # 400 if spammy
    "novafm.com.au": 1.0,                # 429
}
# Custom Referer/Origin where needed
HOST_REFERER = {
    "watch.foxtel.com.au": "https://watch.foxtel.com.au/app/",
    "imageresizer.static9.net.au": "https://www.9now.com.au/",
}

_HOST_LOCKS: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_HOST_NEXT: Dict[str, float] = defaultdict(float)

def _sanitize_logo_url(u: str) -> str:
    # de-html &amp; and space -> %20
    u = (u or "").replace("&amp;", "&").replace(" ", "%20").strip()
    # Remove /refs/heads/ for GitHub raw URLs
    u = u.replace("/refs/heads/", "/")
    return u

async def _wait_host_gate(host: str):
    delay = HOST_RATELIMITS.get(host)
    if not delay:
        return
    async with _HOST_LOCKS[host]:
        now = time.monotonic()
        t   = _HOST_NEXT[host]
        sleep_for = max(0.0, t - now)
        if sleep_for:
            await asyncio.sleep(sleep_for + random.uniform(0, 0.15))
        _HOST_NEXT[host] = max(now, t) + delay

# ==================== HELPERS ====================
_slug_re = re.compile(r'[^a-z0-9]+')

def slugify_id(s: str) -> str:
    """For IDs (MUST match index.js: slice(0,48))."""
    return _slug_re.sub('-', (s or '').lower()).strip('-')[:48]

def slugify_path(s: str) -> str:
    """For filenames (safe, a bit longer so we don't collide)."""
    return _slug_re.sub('-', (s or '').lower()).strip('-')[:96]

def _to_base36(n: int) -> str:
    if n == 0: return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out: List[str] = []
    while n:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return ''.join(reversed(out))

def js_hash32_base36(s: str) -> str:
    """Match JS: h=((h<<5)-h+code)|0 ; then (h>>>0).toString(36)"""
    h = 0
    for ch in s or "":
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
    return _to_base36(h)

async def get_text(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> str:
    async with semaphore:
        async with session.get(url, timeout=HTTP_TIMEOUT, allow_redirects=True) as r:
            r.raise_for_status()
            return await r.text()

def _static9_decode_original(url: str) -> Optional[str]:
    """
    imageresizer.static9.net.au/.../<size>/<ENCODED_ORIGINAL>
    Try to extract and decode the original S3 URL for fallback.
    """
    try:
        parts = url.split('/')
        for seg in reversed(parts):
            dec = urllib.parse.unquote(seg)
            if dec.startswith('http://') or dec.startswith('https://'):
                return dec
    except Exception:
        pass
    return None


def _foxtel_decode_original(url: str) -> Optional[str]:
    """
    Foxtel/Kayo often serve images via a resizer path that embeds the original URL
    as a URL-encoded segment or a 'url=' query parameter. Extract the original asset
    (usually S3/CloudFront) so we can fetch it directly without special cookies.
    """
    try:
        u = urllib.parse.urlsplit(url)
        if "watch.foxtel.com.au" not in u.netloc.lower():
            return None
        # 1) query param ?url=<encoded>
        q = urllib.parse.parse_qs(u.query or "")
        if "url" in q and q["url"]:
            cand = urllib.parse.unquote(q["url"][0])
            if cand.startswith(("http://", "https://")):
                return cand
        # 2) any path segment that decodes to an absolute URL
        for seg in reversed((u.path or "").split('/')):
            dec = urllib.parse.unquote(seg)
            if dec.startswith(("http://", "https://")):
                return dec
    except Exception:
        pass
    return None

async def get_bytes(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> bytes:
    url = _sanitize_logo_url(url)

    if url.startswith("data:"):
        header, data = url.split(",", 1)
        return base64.b64decode(data) if ";base64" in header else data.encode("utf-8", "ignore")

    async with semaphore:
        u = urllib.parse.urlparse(url)
        host = u.netloc.lower()

        # Foxtel/Kayo: try decoding original asset immediately
        if 'watch.foxtel.com.au' in host:
            orig = _foxtel_decode_original(url)
            if orig:
                url = _sanitize_logo_url(orig)
                u = urllib.parse.urlparse(url)
                host = u.netloc.lower()

        # per-host gate
        await _wait_host_gate(host)

        # headers
        headers = {
            "Accept-Language": "en-AU,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"
        }
        referer = HOST_REFERER.get(host)
        if referer:
            headers["Referer"] = referer
            headers["Origin"]  = urllib.parse.urlsplit(referer)._replace(path="", query="", fragment="").geturl()
        else:
            origin = f"{u.scheme}://{u.netloc}"
            headers["Referer"] = origin + "/"
            headers["Origin"]  = origin

        # up to 3 attempts with small backoff
        for attempt in range(3):
            try:
                async with session.get(url, timeout=HTTP_TIMEOUT, allow_redirects=True, headers=headers) as r:
                    # polite retry on 429/403/400
                    if r.status in (429, 403, 400) and attempt < 2:
                        await asyncio.sleep(0.6 + attempt * 0.7)
                        await _wait_host_gate(host)
                        # Static9: try original S3 as a special fallback
                        if r.status in (400, 403) and "imageresizer.static9.net.au" in host:
                            s3 = _static9_decode_original(url)
                            if s3:
                                url = _sanitize_logo_url(s3)
                                u = urllib.parse.urlparse(url)
                                host = u.netloc.lower()
                                # switch headers to neutral for S3
                                headers = {
                                    "Referer": f"{u.scheme}://{u.netloc}/",
                                    "Origin":  f"{u.scheme}://{u.netloc}",
                                    "Accept-Language": "en-AU,en;q=0.9,en-GB;q=0.8,en-US;q=0.7"
                                }
                        continue
                    r.raise_for_status()
                    content = await r.read()
                    ct = r.headers.get("Content-Type", "").lower()
                    if (("svg" in ct) or url.lower().endswith(".svg")) and content and cairosvg:
                        try:
                            return cairosvg.svg2png(bytestring=content, output_width=SIZE, output_height=SIZE)
                        except Exception:
                            return text_placeholder_png(os.path.splitext(os.path.basename(url))[0])
                    return content
            except aiohttp.ClientResponseError as e:
                if e.status in (429, 403, 400, 404) and attempt < 2:
                    await asyncio.sleep(0.8 + attempt * 0.8)
                    await _wait_host_gate(host)
                    if e.status == 404 and '-1-' in url:
                        url = url.replace('-1-', '-')
                        u = urllib.parse.urlparse(url)
                        host = u.netloc.lower()
                    continue
                raise
            except aiohttp.ClientConnectorError as e:
                if attempt < 2:
                    await asyncio.sleep(1.0 + attempt * 1.0)
                    continue
                raise

def _parse_attr_pairs(attr_str: str) -> dict:
    attrs = {}
    for pair in re.split(r'\s*,\s*|\s+', (attr_str or '').strip()):
        if '=' in pair:
            key, val = pair.split('=', 1)
            val = val.strip('"\'')
            if key: attrs[key] = val
    return attrs

def parse_m3u_entries(text: str):
    """Yield dicts with id, name, logo, group, url for each #EXTINF block (first URL)."""
    meta = None
    for raw in (text or '').splitlines():
        line = (raw or '').strip()
        if not line or line.startswith('#EXTM3U'):
            continue
        if line.startswith('#EXTINF'):
            header, disp = _split_extinf_header_display(line)
            attr_str = header.split(' ', 1)[1] if ' ' in header else ""
            attrs = _parse_attr_pairs(attr_str)
            logo = attrs.get('tvg-logo') or attrs.get('logo')
            if not logo:
                m = re.search(r'(?:tvg-logo|logo)\s*=\s*"?(https?://\S+?)"?(?:\s|$|,)', line, re.I)
                if m: logo = m.group(1).rstrip('",')
            if logo:
                logo = _sanitize_logo_url(logo)
            name = (attrs.get('tvg-name') or disp).strip()
            if 'http://' in name or 'https://' in name:
                name = name.split('http://')[0].split('https://')[0].strip(' "')
            gid = attrs.get('tvg-id') or name or None
            group = attrs.get('group-title') or None
            meta = {"id": gid, "name": name or gid, "logo": logo, "group": group}
        elif line.startswith('#EXTGRP:'):
            if meta: meta["group"] = line.split(':', 1)[-1].strip() or meta.get("group")
        elif meta and not line.startswith('#'):
            m = re.search(r'https?://\S+', line)
            url = _sanitize_logo_url(m.group(0)) if m else ""
            yield {"id": meta["id"], "name": meta["name"], "logo": meta["logo"], "group": meta.get("group"), "url": url}
            meta = None

def is_dark_rgba(img: Image.Image) -> bool:
    s = img.copy()
    s.thumbnail((256, 256), Image.LANCZOS)
    tot = cnt = 0.0
    for r, g, b, a in s.getdata():
        if a < 20: continue
        lum = 0.2126*r + 0.7152*g + 0.0722*b
        tot += lum; cnt += 1
    return cnt > 0 and (tot / cnt) < 60.0

def text_placeholder_png(text: str) -> bytes:
    txt = (text or "logo").replace("-", " ").strip()[:40]
    im = Image.new("RGBA", (SIZE, SIZE), BG_DARK)
    draw = ImageDraw.Draw(im)
    try:    font = ImageFont.truetype("arial.ttf", 36)
    except: font = ImageFont.load_default()
    _, _, tw, th = draw.textbbox((0, 0), txt, font=font)
    draw.text(((SIZE - tw)//2, (SIZE - th)//2), txt, font=font, fill=BG_LIGHT)
    buf = io.BytesIO(); im.save(buf, format="PNG")
    return buf.getvalue()

def pad_save_png(buf: bytes, out_path: str) -> Optional[str]:
    try:
        im = Image.open(io.BytesIO(buf)).convert("RGBA")
    except UnidentifiedImageError:
        buf = text_placeholder_png(os.path.splitext(os.path.basename(out_path))[0])
        im  = Image.open(io.BytesIO(buf)).convert("RGBA")
    bg = BG_LIGHT if is_dark_rgba(im) else BG_DARK
    inner = SIZE - (2 * PAD)
    im.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), bg)
    x = PAD + (inner - im.width)//2
    y = PAD + (inner - im.height)//2
    canvas.paste(im, (x, y), im)
    canvas.save(out_path, format="PNG")
    return None

def load_curated_from_map():
    """Allow seeding logos from an existing map file."""
    out = []
    out_map_path = os.path.join(OUT_DIR, "map.json")
    for p in INPUT_MAP_CANDIDATES:
        if not os.path.exists(p) or (os.path.exists(out_map_path) and os.path.samefile(p, out_map_path)):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        def push(idv, logo):
            if idv and logo and isinstance(logo, str) and logo.startswith(("http://","https://","data:")):
                out.append((idv, logo))

        if isinstance(data, dict):
            if all(isinstance(v, str) for v in data.values()):
                for cid, logo in data.items(): push(cid, logo)
            else:
                if "channels" in data and isinstance(data["channels"], list):
                    for e in data["channels"]:
                        push(e.get("id") or e.get("tvg-id") or e.get("name"),
                             e.get("logo") or e.get("tvg-logo"))
                for k, v in data.items():
                    if k == "channels": continue
                    if isinstance(v, list):
                        for e in v:
                            if isinstance(e, dict):
                                push(e.get("id") or e.get("tvg-id") or e.get("name"),
                                     e.get("logo") or e.get("tvg-logo"))
        elif isinstance(data, list):
            for e in data:
                if isinstance(e, dict):
                    push(e.get("id") or e.get("tvg-id") or e.get("name"),
                         e.get("logo") or e.get("tvg-logo"))
        if out: break
    return out

def build_curated_indexes(pairs: Iterable[Tuple[str, str]]):
    by_id: Dict[str, str] = {}
    by_slug: Dict[str, str] = {}
    for cid, logo in pairs:
        by_id[cid] = logo
        by_slug[slugify_id(cid)] = logo
    return by_id, by_slug

# ==================== FETCH ALL CHANNELS ====================
async def fetch_all_channels(session: aiohttp.ClientSession, semaphore: asyncio.Semaphore):
    """
    Returns list of tuples: (cid, name, logo_url, source_prefix)
    For Extras: cid == f"{slugify_id(name or id)}-{js_hash32_base36(url)}"  (== index.js)
    """
    curated_pairs = load_curated_from_map()
    curated_by_id, curated_by_slug = build_curated_indexes(curated_pairs)
    channels: List[Tuple[str, str, Optional[str], str]] = []

    # Seed curated logos to keep them if found later
    for cid, logo in curated_pairs:
        channels.append((cid, cid, logo, "curated-seed"))

    async def fetch_m3u(url, source_prefix):
        try:
            m3u = await get_text(session, url, semaphore)
            if len(m3u) < 100 and source_prefix == "a1x":
                return
            for e in parse_m3u_entries(m3u):
                name = e.get("name") or e.get("id") or ""
                logo = (
                    e.get("logo")
                    or curated_by_id.get(e.get("id") or "")
                    or curated_by_slug.get(slugify_id(e.get("id") or ""))
                    or curated_by_slug.get(slugify_id(name))
                )
                cid = e.get("id") or name
                if source_prefix.startswith("extras-"):
                    url0 = e.get("url") or ""
                    name_slug = slugify_id(name or cid)
                    cid = f"{name_slug}-{js_hash32_base36(url0)}"
                channels.append((cid, name, logo, source_prefix))
        except Exception:
            pass

    tasks = []
    # AU TV/Radio
    for region in REGIONS:
        tasks.append(fetch_m3u(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-tv.m3u8",    f"au:{region}:tv"))
        tasks.append(fetch_m3u(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-radio.m3u8", f"au:{region}:radio"))
    # NZ TV/Radio
    for path in ("raw-tv.m3u8", "raw-radio.m3u8"):
        tasks.append(fetch_m3u(f"https://i.mjh.nz/nz/{path}", f"nz:{path}"))
    # A1X curated
    for u in A1X_SOURCES:
        tasks.append(fetch_m3u(u, "a1x"))
    # Extras (remote list or list of urls)
    for url in (EXTRAS_URLS if isinstance(EXTRAS_URLS, (list, tuple)) else [EXTRAS_URLS]):
        if url: tasks.append(fetch_m3u(url, "extras-remote"))
    # Extras local file (optional)
    if os.path.exists(EXTRAS_PATH):
        try:
            with open(EXTRAS_PATH, "r", encoding="utf-8") as f:
                ex = f.read()
            for e in parse_m3u_entries(ex):
                name = e.get("name") or e.get("id") or ""
                logo = (
                    e.get("logo")
                    or curated_by_id.get(e.get("id") or "")
                    or curated_by_slug.get(slugify_id(e.get("id") or ""))
                    or curated_by_slug.get(slugify_id(name))
                )
                url0 = e.get("url") or ""
                name_slug = slugify_id(name or (e.get("id") or ""))
                cid = f"{name_slug}-{js_hash32_base36(url0)}"
                channels.append((cid, name, logo, "extras-local"))
        except Exception:
            pass

    await asyncio.gather(*[asyncio.create_task(t) for t in tasks], return_exceptions=True)
    return channels

async def gather_with_progress(tasks, desc="Processing", unit="task"):
    results = []
    if not tasks: return results
    with tqdm(total=len(tasks), desc=desc, unit=unit) as pbar:
        for fut in asyncio.as_completed(tasks):
            try:
                res = await fut
            finally:
                pbar.update(1)
            results.append(res)
    return results

# ==================== MAIN ====================
async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seen_paths = set()
    saved = 0
    mapping: Dict[str, str] = {}
    skipped_rows = []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

    t0 = time.time()

    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT_REQUESTS, ttl_dns_cache=300)
    async with aiohttp.ClientSession(
        connector=connector,
        headers={
            # Realistic browser UA helps some CDNs
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
            "Accept": "*/*",
        }
    ) as session:
        channels = await fetch_all_channels(session, semaphore)

        async def process_channel(cid: str, name: str, logo_url: Optional[str], source: str):
            nonlocal saved
            slug = slugify_path(cid)
            if not slug:
                return ["", cid, source, "empty-slug", logo_url or ""]
            out = os.path.join(OUT_DIR, f"{slug}1024.png")
            web_path = f"/images/{slug}1024.png"

            # map key MUST be exact channel id used in index.js
            mapping[cid] = web_path

            # avoid duplicating work if same out path repeats from multiple sources
            if out in seen_paths:
                return None
            seen_paths.add(out)

            if os.path.exists(out):
                return None

            try:
                buf = await get_bytes(session, logo_url, semaphore) if logo_url else text_placeholder_png(name or cid)
                loop = asyncio.get_event_loop()
                with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                    await loop.run_in_executor(executor, pad_save_png, buf, out)
                if os.path.exists(out):
                    saved += 1
                return None
            except aiohttp.ClientResponseError as e:
                return [slug, cid, source, f"http-{e.status}", logo_url or ""]
            except aiohttp.ClientError as e:
                return [slug, cid, source, f"net-{type(e).__name__}", logo_url or ""]
            except Exception as e:
                return [slug, cid, source, f"img-{type(e).__name__}", logo_url or ""]

        tasks = [process_channel(cid, name, logo_url, source) for cid, name, logo_url, source in channels]
        results = await gather_with_progress(tasks, desc="Building posters", unit="ch")
        skipped_rows.extend([r for r in results if r is not None])

    # Write maps
    images_map_path = os.path.join(OUT_DIR, "map.json")
    async with aiofiles.open(images_map_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(mapping, indent=2, ensure_ascii=False))

    root_map_path = os.path.join(ROOT, "map.json")
    async with aiofiles.open(root_map_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(mapping, indent=2, ensure_ascii=False))

    # Zip bundle
    zip_path = os.path.join(OUT_DIR, "images-1024.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in os.listdir(OUT_DIR):
            if fn.endswith("1024.png"):
                z.write(os.path.join(OUT_DIR, fn), arcname=fn)

    # Skips CSV
    if skipped_rows:
        async with aiofiles.open(os.path.join(OUT_DIR, "skipped.csv"), "w", newline='', encoding="utf-8") as f:
            await f.write('slug,id,source,reason,logo_url\n')
            for row in skipped_rows:
                await f.write(','.join(map(str, row)) + '\n')

    # Summary
    reasons: Dict[str, int] = {}
    for _, _, _, reason, _ in skipped_rows:
        reasons[reason] = reasons.get(reason, 0) + 1

    print(f"Done in {time.time() - t0:.1f}s. Saved {saved} images to {OUT_DIR}")
    print(f"ZIP: {zip_path}")
    print(f"Map (images): {images_map_path}")
    print(f"Map (root):   {root_map_path}")
    if skipped_rows:
        print(f"Skipped: {len(skipped_rows)} (see {os.path.join(OUT_DIR, 'skipped.csv')})")
        if reasons:
            print("Top skip reasons:", ", ".join(f"{k}={v}" for k, v in sorted(reasons.items(), key=lambda x: -x[1])[:8]))

if __name__ == "__main__":
    asyncio.run(main())