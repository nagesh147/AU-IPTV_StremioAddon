#!/usr/bin/env python3
# requires: pip install requests pillow
# optional: pip install cairosvg

import os, re, io, json, zipfile, urllib.parse, base64, csv, time
from typing import Dict, Tuple, Iterable, Optional
import requests
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

try:
    import cairosvg  # optional, for SVG -> PNG
except Exception:
    cairosvg = None

INTL_REGIONS = []  # e.g. ["sg","my","hk","de","nl"] if you want those i.mjh.nz regions

# === Config ===
ROOT = os.path.dirname(__file__)
OUT_DIR = os.path.join(ROOT, "images")
SIZE = 512
PAD = 12
BG_DARK  = (24, 24, 24, 255)
BG_LIGHT = (240, 240, 240, 255)

REGIONS = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney']
A1X_SOURCES = (
    "https://bit.ly/a1xstream",
    "https://a1xs.vip/a1xstream",
    "https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u",
)
EXTRAS_PATH = os.path.join(ROOT, "extras.m3u")  # optional pasted block

# optional curated map candidates (root-level). We ignore images/map.json (our output)
INPUT_MAP_CANDIDATES = [
    os.path.join(ROOT, "map.json"),
    os.path.join(ROOT, "curated.json"),
    os.path.join(ROOT, "curated.map.json"),
]

# === HTTP session with UA + retries ===
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; mjh-logo-downloader/1.0; +https://example.local)",
    "Accept": "*/*",
})
ADAPTER = requests.adapters.HTTPAdapter(max_retries=3)
SESSION.mount("http://", ADAPTER)
SESSION.mount("https://", ADAPTER)

# === Helpers ===
def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')

def get(url: str, timeout=25) -> str:
    r = SESSION.get(url, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    return r.text

def get_bytes(url: str, timeout=25) -> bytes:
    # data: URLs support
    if url.startswith("data:"):
        # data:[<mediatype>][;base64],<data>
        try:
            header, data = url.split(",", 1)
            if ";base64" in header:
                return base64.b64decode(data)
            else:
                return data.encode("utf-8", "ignore")
        except Exception:
            raise
    r = SESSION.get(url, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    # SVG -> PNG if possible
    ct = r.headers.get("Content-Type", "").lower()
    if ("svg" in ct or url.lower().endswith(".svg")) and r.content:
        if cairosvg:
            try:
                return cairosvg.svg2png(bytestring=r.content, output_width=SIZE, output_height=SIZE)
            except Exception:
                # fall back to placeholder
                return text_placeholder_png(os.path.splitext(os.path.basename(url))[0])
        else:
            # no converter installed -> placeholder
            return text_placeholder_png(os.path.splitext(os.path.basename(url))[0])
    return r.content

def _parse_attr_pairs(attr_str: str) -> dict:
    """
    Robust key="value" or key='value' scanner that tolerates missing quotes and odd spacing.
    Returns a dict of attributes found in the #EXTINF header segment.
    """
    attrs = {}
    i, n = 0, len(attr_str)
    while i < n:
        while i < n and attr_str[i] in ' ,\t':
            i += 1
        if i >= n:
            break
        k0 = i
        while i < n and attr_str[i] not in '=\t ,':
            i += 1
        key = attr_str[k0:i].strip()
        if i < n and attr_str[i] == '=':
            i += 1
        val = ""
        if i < n and attr_str[i] in ('"', "'"):
            quote = attr_str[i]
            i += 1
            v0 = i
            while i < n and attr_str[i] != quote:
                i += 1
            val = attr_str[v0:i]
            if i < n and attr_str[i] == quote:
                i += 1
        else:
            v0 = i
            while i < n and attr_str[i] not in ' ,\t':
                i += 1
            val = attr_str[v0:i].strip()
        if key:
            attrs[key] = val
    return attrs

def parse_m3u_entries(text: str):
    """
    Yield dicts: {id, name, logo} from an M3U/EXTINF block.
    Tolerant of odd quotes/attrs. Yields when we hit the URL line after #EXTINF.
    """
    idv = name = logo = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('#EXTM3U'):
            continue
        if line.startswith('#EXTINF'):
            if ',' in line:
                header, disp = line.split(',', 1)
            else:
                header, disp = line, ""
            try:
                attr_str = header.split(' ', 1)[1]
            except IndexError:
                attr_str = ""

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
    px = s.getdata()
    tot = cnt = 0.0
    for r, g, b, a in px:
        if a < 20:
            continue
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        tot += lum; cnt += 1
    if cnt == 0:
        return False
    return (tot / cnt) < 60.0

def text_placeholder_png(text: str) -> bytes:
    """
    Generate a simple PNG with the channel name if image is SVG/no converter/unreadable.
    Ensures we don't silently drop entries.
    """
    text = (text or "logo").replace("-", " ").strip()[:40]
    im = Image.new("RGBA", (SIZE, SIZE), (24,24,24,255))
    draw = ImageDraw.Draw(im)
    # Try to fit text roughly
    try:
        font = ImageFont.truetype("arial.ttf", 36)
    except Exception:
        font = ImageFont.load_default()
    tw, th = draw.textbbox((0,0), text, font=font)[2:]
    draw.text(((SIZE - tw)//2, (SIZE - th)//2), text, font=font, fill=(240,240,240,255))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()

def pad_save_png(buf: bytes, out_path: str):
    try:
        im = Image.open(io.BytesIO(buf)).convert("RGBA")
    except UnidentifiedImageError:
        # Try treating it as text placeholder (last resort)
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

def load_curated_from_map():
    """
    Load curated ids/logos from a root-level JSON map (US/UK/CA/SP etc).
    Supports:
      1) flat dict: { "<id>": "<logo_url>", ... }
      2) grouped dict: { "US": [ {id,logo}, ... ], "UK": [...], "SP:sports":[...] }
      3) list of {id,logo}
      4) { "channels": [ {id,logo}, ... ] }
    """
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

def build_curated_indexes(pairs: Iterable[Tuple[str,str]]):
    """
    Build multiple lookup keys to maximize matches (id, name, slug).
    Returns (by_id, by_slug) where both map str->logo_url.
    """
    by_id: Dict[str,str] = {}
    by_slug: Dict[str,str] = {}
    for cid, logo in pairs:
        by_id[cid] = logo
        by_slug[slugify(cid)] = logo
    return by_id, by_slug

# === Sources ===
def fetch_all_channels():
    curated_pairs = load_curated_from_map()
    curated_by_id, curated_by_slug = build_curated_indexes(curated_pairs)

    # Use curated seeds first (ensures they're written)
    for cid, logo in curated_pairs:
        yield (cid, logo, "curated")

    # AU TV + AU Radio (all cities)
    for region in REGIONS:
        # TV
        try:
            m3u = get(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-tv.m3u8")
            for e in parse_m3u_entries(m3u):
                logo = e.get("logo") or au_logo(region, e["id"])
                yield (e["id"], logo, f"au:{region}:tv")
        except Exception:
            pass
        # Radio
        try:
            m3u = get(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-radio.m3u8")
            for e in parse_m3u_entries(m3u):
                logo = e.get("logo") or au_logo(region, e["id"])
                yield (e["id"], logo, f"au:{region}:radio")
        except Exception:
            pass

    # NZ TV + NZ Radio
    for path in ("raw-tv.m3u8", "raw-radio.m3u8"):
        try:
            m3u = get(f"https://i.mjh.nz/nz/{path}")
            for e in parse_m3u_entries(m3u):
                yield (e["id"], e.get("logo") or nz_logo(e["id"]), f"nz:{path}")
        except Exception:
            pass

    # Optional other i.mjh.nz regions
    for r in INTL_REGIONS:
        try:
            m3u = get(f"https://i.mjh.nz/{r}/raw-tv.m3u8")
            for e in parse_m3u_entries(m3u):
                logo = e.get("logo") or f"https://i.mjh.nz/{r}/logo/{urllib.parse.quote(e['id'])}.png"
                yield (e["id"], logo, f"intl:{r}")
        except Exception:
            pass

    # A1X curated (take first source that works)
    for u in A1X_SOURCES:
        try:
            m3u = get(u)
            if len(m3u) < 100:
                continue
            for e in parse_m3u_entries(m3u):
                logo = e.get("logo")
                if not logo:
                    # Try curated by id, then by slug of id, then by slug of name
                    logo = curated_by_id.get(e["id"]) \
                        or curated_by_slug.get(slugify(e["id"])) \
                        or curated_by_slug.get(slugify(e.get("name") or ""))
                if logo:
                    yield (e["id"], logo, "a1x")
            break
        except Exception:
            continue

    # Your pasted extras (optional)
    if os.path.exists(EXTRAS_PATH):
        try:
            with open(EXTRAS_PATH, "r", encoding="utf-8") as f:
                ex = f.read()
            for e in parse_m3u_entries(ex):
                logo = e.get("logo") \
                    or curated_by_id.get(e["id"]) \
                    or curated_by_slug.get(slugify(e["id"])) \
                    or curated_by_slug.get(slugify(e.get("name") or ""))
                if logo:
                    yield (e["id"], logo, "extras")
        except Exception:
            pass


# === Main ===
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seen = set()
    saved = 0
    mapping = {}  # original id -> /images/<slug>512.png
    skipped_rows = []  # [slug, id, source, reason, logo_url]

    t0 = time.time()

    for cid, logo_url, source in fetch_all_channels():
        slug = slugify(cid)
        if not slug:
            skipped_rows.append(["", cid, source, "empty-slug", logo_url or ""])
            continue
        if slug in seen:
            # Not an error; just dedupe
            continue
        seen.add(slug)

        out = os.path.join(OUT_DIR, f"{slug}512.png")
        web_path = f"/images/{slug}512.png"
        mapping[cid] = web_path

        if os.path.exists(out):
            continue

        if not logo_url:
            skipped_rows.append([slug, cid, source, "no-logo-url", ""])
            continue

        try:
            buf = get_bytes(logo_url)
            pad_save_png(buf, out)
            if os.path.exists(out):
                saved += 1
        except requests.HTTPError as e:
            skipped_rows.append([slug, cid, source, f"http-{e.response.status_code}", logo_url])
        except requests.RequestException as e:
            skipped_rows.append([slug, cid, source, f"net-error:{type(e).__name__}", logo_url])
        except Exception as e:
            skipped_rows.append([slug, cid, source, f"img-error:{type(e).__name__}", logo_url])

    # Save map for index.js usage (local images)
    with open(os.path.join(OUT_DIR, "map.json"), "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    # Zip them
    zip_path = os.path.join(OUT_DIR, "images-512.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in os.listdir(OUT_DIR):
            if fn.endswith("512.png"):
                z.write(os.path.join(OUT_DIR, fn), arcname=fn)

    # Skips report
    if skipped_rows:
        with open(os.path.join(OUT_DIR, "skipped.csv"), "w", newline='', encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["slug","id","source","reason","logo_url"])
            w.writerows(skipped_rows)

    # Summary
    reasons = {}
    for _,_,_,reason,_ in skipped_rows:
        reasons[reason] = reasons.get(reason, 0) + 1

    print(f"Done in {time.time()-t0:.1f}s. Saved {saved} images to {OUT_DIR}")
    print(f"ZIP: {zip_path}")
    print(f"Map: {os.path.join(OUT_DIR, 'map.json')}")
    if skipped_rows:
        print(f"Skipped: {len(skipped_rows)} (see {os.path.join(OUT_DIR, 'skipped.csv')})")
        if reasons:
            print("Top skip reasons:", ", ".join(f"{k}={v}" for k,v in sorted(reasons.items(), key=lambda x: -x[1])[:8]))

if __name__ == "__main__":
    main()
