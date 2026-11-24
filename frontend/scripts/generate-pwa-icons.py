"""Regenerate PWA icons + in-app logo from the user's Alfalah University logo.

Source: ~/workspace/user/files/1795528959162_15_t5qm.jpg
(556x552 JPG, dark-blue Alfalah calligraphy + "2011 ALFALAH UNIVERSITY"
text on white). The logo is used as given, not redesigned.

- icon-192 / icon-512 / apple-touch-icon: full logo centred on white.
- icon-512-maskable: ONLY the calligraphy mark (the text band at the
  bottom is cropped out), centred on white inside the central 80% safe zone.
- logo.png: full logo, 512px wide, on white, for use inside the app.
"""
import os
from PIL import Image

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.expanduser(
    "~/workspace/user/files/1795528959162_15_t5qm.jpg")
OUT = os.path.join(FRONTEND_DIR, "public", "icons")
PUBLIC = os.path.join(FRONTEND_DIR, "public")
os.makedirs(OUT, exist_ok=True)

WHITE = (255, 255, 255)


def trim(img, thresh=245):
    """Crop to the bounding box of non-white pixels."""
    gray = img.convert("L")
    w, h = gray.size
    px = gray.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y] < thresh:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    return img.crop((minx, miny, maxx + 1, maxy + 1))


def paste_centred(canvas_size, art, max_frac):
    """White canvas of canvas_size with art scaled to fit max_frac of it."""
    canvas = Image.new("RGB", (canvas_size, canvas_size), WHITE)
    limit = int(canvas_size * max_frac)
    scale = min(limit / art.width, limit / art.height)
    nw, nh = max(1, int(art.width * scale)), max(1, int(art.height * scale))
    art = art.resize((nw, nh), Image.LANCZOS)
    canvas.paste(art, ((canvas_size - nw) // 2, (canvas_size - nh) // 2))
    return canvas


src = Image.open(SRC).convert("RGB")
full = trim(src)
print("full logo trimmed:", full.size)

# Calligraphy mark only: rows 31..426 of the original (the "2011" digits
# sit at y=425..442 and "ALFALAH UNIVERSITY" at y=447..465; the mark's
# lowest flourish ends ~y=425). Measured from the source image on 2026-11-24.
mark_region = src.crop((0, 31, src.width, 426))
mark = trim(mark_region)
print("calligraphy mark trimmed:", mark.size)

# Full-logo icons (modest padding so the text stays legible)
paste_centred(192, full, 0.88).save(
    os.path.join(OUT, "icon-192.png"), "PNG", optimize=True)
paste_centred(512, full, 0.88).save(
    os.path.join(OUT, "icon-512.png"), "PNG", optimize=True)
paste_centred(180, full, 0.88).save(
    os.path.join(OUT, "apple-touch-icon.png"), "PNG", optimize=True)

# Maskable: mark only, inside the central 80% safe zone
paste_centred(512, mark, 0.80).save(
    os.path.join(OUT, "icon-512-maskable.png"), "PNG", optimize=True)

# In-app logo
paste_centred(512, full, 0.92).save(
    os.path.join(PUBLIC, "logo.png"), "PNG", optimize=True)

for name in ["icon-192.png", "icon-512.png", "icon-512-maskable.png",
             "apple-touch-icon.png"]:
    p = os.path.join(OUT, name)
    print(p, Image.open(p).size)
print(os.path.join(PUBLIC, "logo.png"), Image.open(os.path.join(PUBLIC, "logo.png")).size)
print("done")
