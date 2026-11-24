"""Generate PWA icons for the Exam Management System.
Design: rounded-square brand-blue (#1d4ed8) background with a white
graduation cap (mortarboard + tassel) and a small checkmark.
Maskable version keeps the artwork inside the central 80% safe zone.
"""
import os
from PIL import Image, ImageDraw

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(FRONTEND_DIR, "public", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (29, 78, 216)        # brand #1d4ed8
BG_DARK = (30, 58, 138)   # brand dark #1e3a8a
WHITE = (255, 255, 255)
GOLD = (251, 191, 36)     # amber accent for the tassel


def rounded_bg(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.14), fill=BG)
    return img, d


def draw_cap(d, size, scale=1.0, cx=None, cy=None):
    """Draw a graduation cap centred at (cx, cy); cap spans ~scale*size."""
    cx = cx if cx is not None else size / 2
    cy = cy if cy is not None else size / 2
    u = size * scale / 512.0  # unit scaled to a 512 canvas
    # Mortarboard (diamond)
    d.polygon([
        (cx - 190 * u, cy - 30 * u),
        (cx, cy - 110 * u),
        (cx + 190 * u, cy - 30 * u),
        (cx, cy + 50 * u),
    ], fill=WHITE)
    # Cap base (head)
    d.polygon([
        (cx - 105 * u, cy + 5 * u),
        (cx + 105 * u, cy + 5 * u),
        (cx + 105 * u, cy + 55 * u),
        (cx + 78 * u, cy + 95 * u),
        (cx - 78 * u, cy + 95 * u),
        (cx - 105 * u, cy + 55 * u),
    ], fill=WHITE)
    # Tassel cord + tassel on the right side
    d.line([(cx + 190 * u, cy - 30 * u), (cx + 190 * u, cy + 95 * u)],
           fill=GOLD, width=max(2, int(10 * u)))
    d.polygon([
        (cx + 172 * u, cy + 95 * u),
        (cx + 208 * u, cy + 95 * u),
        (cx + 200 * u, cy + 145 * u),
        (cx + 180 * u, cy + 145 * u),
    ], fill=GOLD)
    # Small checkmark under the cap, in gold
    w = 34 * u
    d.line([(cx - 95 * u, cy + 150 * u), (cx - 55 * u, cy + 190 * u),
            (cx + 15 * u, cy + 105 * u)],
           fill=GOLD, width=max(3, int(20 * u)), joint="curve")


def make(size, path, maskable=False):
    img, d = rounded_bg(size)
    if maskable:
        # Safe zone: artwork inside central 80% -> scale 0.8 and centre
        draw_cap(d, size, scale=0.8)
    else:
        draw_cap(d, size, scale=1.0)
    img.convert("RGB").save(path, "PNG", optimize=True)
    print(path, img.size)


make(192, os.path.join(OUT, "icon-192.png"))
make(512, os.path.join(OUT, "icon-512.png"))
make(512, os.path.join(OUT, "icon-512-maskable.png"), maskable=True)
# Apple touch icon: no transparency, plain square background
img, d = rounded_bg(180)
draw_cap(d, 180, scale=1.0)
img.convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"), "PNG", optimize=True)
print(os.path.join(OUT, "apple-touch-icon.png"), img.size)
print("done")
