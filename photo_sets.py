"""Bundled trade photo sets for GemSi reports.

Replicates the crops that produced photos/auto_images.json (DriveOz) and the
movers set embedded in safeway_master.json. Offsets were recovered by pixel
matching the derived crops against the source JPEGs (mean abs error < 3.5/255
for every crop, i.e. only JPEG re-encoding noise). PIL quality=90 reproduces the
original encodings byte for byte for the uncropped sources.

Each report image key maps to one or more (source file, crop box) entries.
A crop box of None means the whole source image.
"""
import base64
import io
import threading
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
PHOTO_DIR = HERE / "photos"
JPEG_QUALITY = 90

PHOTO_KEYS = ("p1_hero", "p2_sources", "p2_shows", "p4_hero", "p4_band")

# (file, (left, top, right, bottom)) -- None = full image
TRADE_SETS = {
    "auto_leasing": {
        "p1_hero": ("auto_hero.jpg", (150, 0, 568, 390)),       # 418x390
        "p2_sources": [
            ("auto_phone.jpg", None),                            # 410x196
            ("auto_showroom.jpg", None),                         # 391x196
            ("auto_keys.jpg", None),                             # 410x183
            ("auto_aerial.jpg", None),                           # 391x183
        ],
        "p2_shows": [
            ("auto_band.jpg", (180, 0, 375, 147)),              # 195x147
            ("auto_hero.jpg", (420, 0, 668, 190)),              # 248x190
            ("auto_band.jpg", (700, 0, 895, 147)),              # 195x147
            ("auto_band.jpg", (1250, 0, 1445, 147)),            # 195x147
        ],
        "p4_hero": ("auto_hero.jpg", (440, 0, 668, 330)),       # 228x330
        "p4_band": ("auto_aerial.jpg", None),                   # 391x183
    },
    "movers": {
        "p1_hero": ("move_hero.jpg", (60, 0, 390, 308)),        # 330x308
        "p2_sources": [
            ("move_condo.jpg", None),                            # 482x146
            ("move_elevator.jpg", None),                         # 491x146
            ("move_dock.jpg", None),                             # 482x151
            ("move_aerial.jpg", None),                           # 491x151
        ],
        "p2_shows": [
            ("move_band.jpg", (100, 0, 328, 172)),              # 228x172
            ("move_band.jpg", (500, 0, 728, 172)),              # 228x172
            ("move_band.jpg", (900, 0, 1128, 172)),             # 228x172
            ("move_band.jpg", (1250, 0, 1478, 172)),            # 228x172
        ],
        "p4_hero": ("move_hero.jpg", (0, 0, 200, 308)),         # 200x308
        "p4_band": ("move_aerial.jpg", None),                   # 491x151
    },
}

def _lex_set(prefix: str, h: int):
    """Sets cropped from Lex's 2026-10-05 contact sheet (tiles upscaled 1.5x, see photos/<prefix>_*.jpg).
    Boxes are chosen to match the aspect ratios of the auto_leasing slots."""
    def box(fx0, fy0, fx1, fy1, w):
        return (int(w * fx0), int(h * fy0), int(w * fx1), int(h * fy1))
    return {
        "p1_hero": (f"{prefix}_hero.jpg", box(0.12, 0.0, 0.88, 1.0, 516)),          # ~392 x h (1.08)
        "p2_sources": [
            (f"{prefix}_hero.jpg", box(0.0, 0.22, 1.0, 0.90, 516)),                  # 2.1:1
            (f"{prefix}_sources.jpg", box(0.0, 0.22, 1.0, 0.78, 423)),
            (f"{prefix}_shows.jpg", box(0.0, 0.25, 1.0, 0.74, 370)),
            (f"{prefix}_p4hero.jpg", box(0.0, 0.22, 1.0, 0.82, 451)),
        ],
        "p2_shows": [
            (f"{prefix}_sources.jpg", box(0.05, 0.08, 0.95, 0.88, 423)),             # ~1.33
            (f"{prefix}_shows.jpg", box(0.0, 0.08, 1.0, 0.86, 370)),
            (f"{prefix}_p4hero.jpg", box(0.07, 0.08, 0.93, 0.82, 451)),
            (f"{prefix}_hero.jpg", box(0.12, 0.08, 0.88, 0.82, 516)),
        ],
        "p4_hero": (f"{prefix}_p4hero.jpg", box(0.22, 0.0, 0.78, 1.0, 451)),        # portrait ~0.7
        "p4_band": (f"{prefix}_band.jpg", box(0.0, 0.22, 1.0, 0.85, 481)),          # ~2.14
    }


TRADE_SETS["roofing"] = _lex_set("roof", 360)
TRADE_SETS["hvac"] = _lex_set("hvac", 363)
TRADE_SETS["plumbing"] = _lex_set("plumb", 354)

TRADES = tuple(TRADE_SETS)

_cache: dict = {}
_lock = threading.Lock()


def _data_uri(src: str, box) -> str:
    im = Image.open(PHOTO_DIR / src).convert("RGB")
    if box is not None:
        im = im.crop(box)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=JPEG_QUALITY)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def build_set(trade: str) -> dict:
    """Return {key: data_uri | [data_uri...]} for a trade. Cached after first build."""
    if trade not in TRADE_SETS:
        raise KeyError(trade)
    with _lock:
        if trade in _cache:
            return _cache[trade]
        spec = TRADE_SETS[trade]
        out = {}
        for key in PHOTO_KEYS:
            entry = spec[key]
            if isinstance(entry, list):
                out[key] = [_data_uri(f, b) for f, b in entry]
            else:
                out[key] = _data_uri(*entry)
        _cache[trade] = out
        return out


def _present(v) -> bool:
    if isinstance(v, list):
        return len(v) > 0 and all(isinstance(x, str) and x for x in v)
    return isinstance(v, str) and bool(v)


def fill_missing_photos(images: dict, trade) -> list:
    """Fill absent/empty photo keys in `images` from the trade set, in place.
    Returns the list of keys that were filled. Never overwrites a provided image."""
    if not trade:
        return []
    photos = build_set(trade)
    filled = []
    for key in PHOTO_KEYS:
        if not _present(images.get(key)):
            images[key] = photos[key]
            filled.append(key)
    return filled
