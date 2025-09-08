#!/usr/bin/env python3
# requires: pip install aiohttp aiofiles pillow tqdm
# optional: pip install cairosvg

import os
import re
import io
import json
import zipfile
import urllib.parse
import base64
import csv
import time
import asyncio
import aiohttp
import aiofiles
from typing import Dict, Tuple, Iterable, Optional
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from tqdm.asyncio import tqdm

try:
    import cairosvg  # optional, for SVG -> PNG
except Exception:
    cairosvg = None

INTL_REGIONS: list[str] = []  # e.g. ["sg","my","hk","de","nl"]

# === Config ===
ROOT = os.path.dirname(__file__)
OUT_DIR = os.path.join(ROOT, "images")
SIZE = 512
PAD = 12
BG_DARK = (24, 24, 24, 255)
BG_LIGHT = (240, 240, 240, 255)

REGIONS = ['Adelaide', 'Brisbane', 'Canberra', 'Darwin', 'Hobart', 'Melbourne', 'Perth', 'Sydney']

A1X_SOURCES = (
    "https://bit.ly/a1xstream",
    "https://a1xs.vip/a1xstream",
    "https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u",
)

EXTRAS_URLS = (
    os.getenv("EXTRAS_URL") or
    "https://gist.githubusercontent.com/One800burner/dae77ddddc1b83d3a4d7b34d2bd96a5e/raw/1roguevip.m3u",
)
EXTRAS_PATH = os.path.join(ROOT, "extras.m3u")

INPUT_MAP_CANDIDATES = [
    os.path.join(ROOT, "map.json"),
    os.path.join(ROOT, "curated.json"),
    os.path.join(ROOT, "curated.map.json"),
]

# === HTTP Config ===
HTTP_TIMEOUT = 25
MAX_CONCURRENT_REQUESTS = 50  # Adjust based on system/network
MAX_WORKERS = 16  # Match CPU threads

# === Helpers ===
def slugify(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

async def get_text(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> str:
    async with semaphore:
        async with session.get(url, timeout=HTTP_TIMEOUT, allow_redirects=True) as r:
            r.raise_for_status()
            return await r.text()

async def get_bytes(session: aiohttp.ClientSession, url: str, semaphore: asyncio.Semaphore) -> bytes:
    if url.startswith("data:"):
        header, data = url.split(",", 1)
        if ";base64" in header:
            return base64.b64decode(data)
        return data.encode("utf-8", "ignore")

    async with semaphore:
        headers = {}
        try:
            uo = urllib.parse.urlparse(url)
            origin = f"{uo.scheme}://{uo.netloc}"
            headers["Referer"] = origin + "/"
            headers["Origin"] = origin
        except Exception:
            pass

        async with session.get(url, timeout=HTTP_TIMEOUT, allow_redirects=True, headers=headers) as r:
            r.raise_for_status()
            content = await r.read()
            ct = r.headers.get("Content-Type", "").lower()
            if ("svg" in ct or url.lower().endswith(".svg")) and content and cairosvg:
                try:
                    return cairosvg.svg2png(bytestring=content, output_width=SIZE, output_height=SIZE)
                except Exception:
                    return text_placeholder_png(os.path.splitext(os.path.basename(url))[0])
            return content

def _parse_attr_pairs(attr_str: str) -> dict:
    attrs = {}
    for pair in re.split(r'\s*,\s*|\s+', attr_str.strip()):
        if '=' in pair:
            key, val = pair.split('=', 1)
            val = val.strip('"\'')
            if key:
                attrs[key] = val
    return attrs

def parse_m3u_entries(text: str):
    idv = name = logo = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#EXTM3U'):
            continue
        if line.startswith('#EXTINF'):
            header, disp = line.split(',', 1) if ',' in line else (line, "")
            attr_str = header.split(' ', 1)[1] if ' ' in header else ""
            attrs = _parse_attr_pairs(attr_str)
            logo = attrs.get('tvg-logo') or attrs.get('logo')
            if not logo:
                m = re.search(r'(?:tvg-logo|logo)\s*=\s*"?(https?://\S+?)"?(?:\s|$|,)', line, re.I)
                if m:
                    logo = m.group(1).rstrip('",')
            name = (attrs.get('tvg-name') or disp).strip()
            if 'http://' in name or 'https://' in name:
                name = name.split('http://')[0].split('https://')[0].strip(' "')
            idv = (attrs.get('tvg-id') or name or None)
        elif not line.startswith('#') and idv:
            yield {"id": idv, "name": name or idv, "logo": logo}
            idv = name = logo = None

def au_logo(region: str, cid: str) -> str:
    return f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/logo/{urllib.parse.quote(cid)}.png"

def nz_logo(cid: str) -> str:
    return f"https://i.mjh.nz/nz/logo/{urllib.parse.quote(cid)}.png"

def is_dark_rgba(img: Image.Image) -> bool:
    s = img.copy()
    s.thumbnail((256, 256), Image.LANCZOS)
    tot = cnt = 0.0
    for r, g, b, a in s.getdata():
        if a < 20:
            continue
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        tot += lum
        cnt += 1
    return cnt > 0 and (tot / cnt) < 60.0

def text_placeholder_png(text: str) -> bytes:
    text = (text or "logo").replace("-", " ").strip()[:40]
    im = Image.new("RGBA", (SIZE, SIZE), BG_DARK)
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", 36)
    except Exception:
        font = ImageFont.load_default()
    _, _, tw, th = draw.textbbox((0, 0), text, font=font)
    draw.text(((SIZE - tw) // 2, (SIZE - th) // 2), text, font=font, fill=BG_LIGHT)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()

def pad_save_png(buf: bytes, out_path: str) -> Optional[str]:
    try:
        im = Image.open(io.BytesIO(buf)).convert("RGBA")
    except UnidentifiedImageError:
        buf = text_placeholder_png(os.path.splitext(os.path.basename(out_path))[0])
        im = Image.open(io.BytesIO(buf)).convert("RGBA")
    bg = BG_LIGHT if is_dark_rgba(im) else BG_DARK
    inner = SIZE - (2 * PAD)
    im.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), bg)
    x = PAD + (inner - im.width) // 2
    y = PAD + (inner - im.height) // 2
    canvas.paste(im, (x, y), im)
    canvas.save(out_path, format="PNG")
    return None

def load_curated_from_map():
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
            if idv and logo and isinstance(logo, str) and logo.startswith(("http://", "https://", "data:")):
                out.append((idv, logo))

        if isinstance(data, dict):
            simple = all(isinstance(v, str) for v in data.values())
            if simple:
                for cid, logo in data.items():
                    push(cid, logo)
            else:
                if "channels" in data and isinstance(data["channels"], list):
                    for e in data["channels"]:
                        push(e.get("id") or e.get("tvg-id") or e.get("name"), e.get("logo") or e.get("tvg-logo"))
                for k, v in data.items():
                    if k == "channels":
                        continue
                    if isinstance(v, list):
                        for e in v:
                            if isinstance(e, dict):
                                push(e.get("id") or e.get("tvg-id") or e.get("name"), e.get("logo") or e.get("tvg-logo"))
        elif isinstance(data, list):
            for e in data:
                if isinstance(e, dict):
                    push(e.get("id") or e.get("tvg-id") or e.get("name"), e.get("logo") or e.get("tvg-logo"))
        if out:
            break
    return out

def build_curated_indexes(pairs: Iterable[Tuple[str, str]]):
    by_id: Dict[str, str] = {}
    by_slug: Dict[str, str] = {}
    for cid, logo in pairs:
        by_id[cid] = logo
        by_slug[slugify(cid)] = logo
    return by_id, by_slug

async def fetch_all_channels(session: aiohttp.ClientSession, semaphore: asyncio.Semaphore):
    curated_pairs = load_curated_from_map()
    curated_by_id, curated_by_slug = build_curated_indexes(curated_pairs)
    channels = []

    for cid, logo in curated_pairs:
        channels.append((cid, logo, "curated-seed"))

    async def fetch_m3u(url, source_prefix):
        try:
            m3u = await get_text(session, url, semaphore)
            if len(m3u) < 100 and source_prefix == "a1x":
                return
            for e in parse_m3u_entries(m3u):
                logo = e.get("logo") or curated_by_id.get(e["id"]) or curated_by_slug.get(slugify(e["id"])) or \
                       curated_by_slug.get(slugify(e.get("name") or ""))
                if logo:
                    channels.append((e["id"], logo, source_prefix))
        except Exception:
            pass

    tasks = []
    for region in REGIONS:
        tasks.append(fetch_m3u(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-tv.m3u8", f"au:{region}:tv"))
        tasks.append(fetch_m3u(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-radio.m3u8", f"au:{region}:radio"))
    
    for path in ("raw-tv.m3u8", "raw-radio.m3u8"):
        tasks.append(fetch_m3u(f"https://i.mjh.nz/nz/{path}", f"nz:{path}"))
    
    for r in INTL_REGIONS:
        tasks.append(fetch_m3u(f"https://i.mjh.nz/{r}/raw-tv.m3u8", f"intl:{r}"))
    
    for u in A1X_SOURCES:
        tasks.append(fetch_m3u(u, "a1x"))
    
    for url in (EXTRAS_URLS if isinstance(EXTRAS_URLS, (list, tuple)) else [EXTRAS_URLS]):
        if url:
            tasks.append(fetch_m3u(url, "extras-remote"))
    
    if os.path.exists(EXTRAS_PATH):
        try:
            with open(EXTRAS_PATH, "r", encoding="utf-8") as f:
                ex = f.read()
            for e in parse_m3u_entries(ex):
                logo = e.get("logo") or curated_by_id.get(e["id"]) or curated_by_slug.get(slugify(e["id"])) or \
                       curated_by_slug.get(slugify(e.get("name") or ""))
                if logo:
                    channels.append((e["id"], logo, "extras-local"))
        except Exception:
            pass

    await asyncio.gather(*tasks, return_exceptions=True)
    return channels

async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seen = set()
    saved = 0
    mapping: Dict[str, str] = {}
    skipped_rows = []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

    t0 = time.time()

    async with aiohttp.ClientSession(headers={
        "User-Agent": "Mozilla/5.0 (compatible; au-iptv-poster/2.7; +https://example.local)",
        "Accept": "*/*",
    }) as session:
        channels = await fetch_all_channels(session, semaphore)
        
        async def process_channel(cid: str, logo_url: str, source: str):
            slug = slugify(cid)
            if not slug:
                return ["", cid, source, "empty-slug", logo_url or ""]
            if slug in seen:
                return None
            seen.add(slug)

            out = os.path.join(OUT_DIR, f"{slug}512.png")
            web_path = f"/images/{slug}512.png"
            mapping[cid] = web_path

            if os.path.exists(out):
                return None

            if not logo_url:
                return [slug, cid, source, "no-logo-url", ""]
            
            try:
                buf = await get_bytes(session, logo_url, semaphore)
                with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                    loop = asyncio.get_event_loop()
                    await loop.run_in_executor(executor, pad_save_png, buf, out)
                if os.path.exists(out):
                    nonlocal saved
                    saved += 1
                return None
            except aiohttp.ClientResponseError as e:
                return [slug, cid, source, f"http-{e.status}", logo_url]
            except aiohttp.ClientError as e:
                return [slug, cid, source, f"net-error:{type(e).__name__}", logo_url]
            except Exception as e:
                return [slug, cid, source, f"img-error:{type(e).__name__}", logo_url]

        tasks = [process_channel(cid, logo_url, source) for cid, logo_url, source in channels]
        results = await tqdm.gather(*tasks, desc="Processing channels", unit="channel")
        skipped_rows.extend([r for r in results if r is not None])

    images_map_path = os.path.join(OUT_DIR, "map.json")
    async with aiofiles.open(images_map_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(mapping, indent=2, ensure_ascii=False))

    root_map_path = os.path.join(ROOT, "map.json")
    async with aiofiles.open(root_map_path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(mapping, indent=2, ensure_ascii=False))

    zip_path = os.path.join(OUT_DIR, "images-512.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in os.listdir(OUT_DIR):
            if fn.endswith("512.png"):
                z.write(os.path.join(OUT_DIR, fn), arcname=fn)

    if skipped_rows:
        async with aiofiles.open(os.path.join(OUT_DIR, "skipped.csv"), "w", newline='', encoding="utf-8") as f:
            w = csv.writer(f)
            await f.write(','.join(["slug", "id", "source", "reason", "logo_url"]) + '\n')
            for row in skipped_rows:
                await f.write(','.join(map(str, row)) + '\n')

    reasons = {}
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