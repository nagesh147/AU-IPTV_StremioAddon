#!/usr/bin/env python3
#wip script for scraping images and converting to channel logos
#requires: pip install requests pillow
import os, re, io, json, zipfile, urllib.parse, requests
from PIL import Image

# === Config ===
OUT_DIR = os.path.join(os.path.dirname(__file__), "images")
SIZE = 512
PAD = 12
BG_DARK  = (24, 24, 24, 255)
BG_LIGHT = (24, 24, 24, 255)

REGIONS = ['Adelaide','Brisbane','Canberra','Darwin','Hobart','Melbourne','Perth','Sydney']
A1X_SOURCES = (
    "https://bit.ly/a1xstream",
    "https://a1xs.vip/a1xstream",
    "https://raw.githubusercontent.com/a1xmedia/m3u/refs/heads/main/a1x.m3u",
)
EXTRAS_PATH = os.path.join(os.path.dirname(__file__), "extras.m3u")  # paste your long block here

# === Helpers ===
def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')

def get(url: str) -> str:
    r = requests.get(url, timeout=25, allow_redirects=True)
    r.raise_for_status()
    return r.text

def get_bytes(url: str) -> bytes:
    r = requests.get(url, timeout=25, allow_redirects=True)
    r.raise_for_status()
    return r.content

def parse_m3u_entries(text: str):
    """Yield dicts: {id, name, logo}."""
    idv = name = logo = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line: 
            continue
        if line.startswith('#EXTINF'):
            parts = line.split(',', 1)
            name = (parts[-1].strip() if parts else None) or None
            m_id = re.search(r'tvg-id="([^"]+)"', line, re.I)
            m_logo = re.search(r'tvg-logo="([^"]+)"', line, re.I)
            idv = (m_id.group(1) if m_id else name) or name
            logo = m_logo.group(1) if m_logo else None
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
        if a < 20:  # ignore near-transparent
            continue
        # relative luminance (0..255)
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        tot += lum; cnt += 1
    if cnt == 0:
        return False
    return (tot / cnt) < 60.0

def pad_save_png(buf: bytes, out_path: str):
    im = Image.open(io.BytesIO(buf)).convert("RGBA")
    bg = BG_LIGHT if is_dark_rgba(im) else BG_DARK

    inner = SIZE - (2 * PAD)
    im.thumbnail((inner, inner), Image.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), bg)
    x = PAD + (inner - im.width) // 2
    y = PAD + (inner - im.height) // 2
    canvas.paste(im, (x, y), im)
    canvas.save(out_path, format="PNG")

# === Sources ===
def fetch_all_channels():
    # AU TV + AU Radio (all cities)
    for region in REGIONS:
        # TV
        try:
            m3u = get(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-tv.m3u8")
            for e in parse_m3u_entries(m3u):
                yield (e["id"], e.get("logo") or au_logo(region, e["id"]))
        except Exception:
            pass
        # Radio
        try:
            m3u = get(f"https://i.mjh.nz/au/{urllib.parse.quote(region)}/raw-radio.m3u8")
            for e in parse_m3u_entries(m3u):
                yield (e["id"], e.get("logo") or au_logo(region, e["id"]))
        except Exception:
            pass

    # NZ TV + NZ Radio
    for path in ("raw-tv.m3u8", "raw-radio.m3u8"):
        try:
            m3u = get(f"https://i.mjh.nz/nz/{path}")
            for e in parse_m3u_entries(m3u):
                yield (e["id"], e.get("logo") or nz_logo(e["id"]))
        except Exception:
            pass

    # A1X curated (take first source that works)
    for u in A1X_SOURCES:
        try:
            m3u = get(u)
            if len(m3u) < 100:
                continue
            for e in parse_m3u_entries(m3u):
                if e.get("logo"):
                    yield (e["id"], e["logo"])
            break
        except Exception:
            continue

    # Your pasted extras (optional)
    if os.path.exists(EXTRAS_PATH):
        try:
            with open(EXTRAS_PATH, "r", encoding="utf-8") as f:
                ex = f.read()
            for e in parse_m3u_entries(ex):
                if e.get("logo"):
                    yield (e["id"], e["logo"])
        except Exception:
            pass

# === Main ===
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seen = set()
    saved = 0
    mapping = {}  # original id -> /images/<slug>512.png

    for cid, logo_url in fetch_all_channels():
        slug = slugify(cid)
        if not slug or slug in seen:
            continue
        seen.add(slug)

        out = os.path.join(OUT_DIR, f"{slug}512.png")
        web_path = f"/images/{slug}512.png"
        mapping[cid] = web_path

        if os.path.exists(out):
            continue
        try:
            buf = get_bytes(logo_url)
            pad_save_png(buf, out)
            saved += 1
        except Exception:
            # ignore failures, continue
            pass

    # Save map for index.js usage if you want to route to local images
    with open(os.path.join(OUT_DIR, "map.json"), "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    # Zip them
    zip_path = os.path.join(OUT_DIR, "images-512.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in os.listdir(OUT_DIR):
            if fn.endswith("512.png"):
                z.write(os.path.join(OUT_DIR, fn), arcname=fn)

    print(f"Done. Saved {saved} images to {OUT_DIR}")
    print(f"ZIP: {zip_path}")
    print(f"Map: {os.path.join(OUT_DIR, 'map.json')}")

if __name__ == "__main__":
    main()
