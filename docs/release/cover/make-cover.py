"""
"UPDATED" corner ribbon for the Steam Workshop cover of Cactus.

    python docs/release/cover/make-cover.py

Input:  original-workshop-cover.jpg (copy of <Kenshi>/mods/Cactus Info/_Cactus Info.img, never changed)
Output: cover-updated-<variant>.png next to this script, same size as the original.
Only the ribbon (and its soft shadow) is drawn on top; every other pixel is the original's
(PNG, lossless). The script fails if a result is 1 MB or bigger (Steam preview limit).

The ribbon sits in the top-right corner: the title "CACTUS" ends at x - y = 779 (measured),
so every variant keeps its inner edge above x - y = 800 and never touches the title,
the logo or the screenshot.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "original-workshop-cover.jpg")
FONT = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "seguibl.ttf")  # Segoe UI Black
TITLE_LIMIT = 779  # max x - y of the title pixels

YELLOW = (255, 201, 60, 255)
EDGE = (196, 140, 16, 255)
TEXT = (27, 31, 26, 255)

# inner / outer: the band between the lines x - y = inner and x - y = outer.
VARIANTS = {
    "a-classic": {"inner": 808, "outer": 930, "stitch": True},
    "b-slim": {"inner": 838, "outer": 930, "stitch": False},
    "c-wide": {"inner": 802, "outer": 965, "stitch": True},
}


def ribbon(img: Image.Image, inner: int, outer: int, stitch: bool) -> Image.Image:
    w, h = img.size
    assert inner > TITLE_LIMIT + 20, "ribbon would touch the title"
    band = (outer - inner) / 2**0.5  # perpendicular width
    length = int(w * 1.6)
    strip = Image.new("RGBA", (length, int(round(band))), (0, 0, 0, 0))
    d = ImageDraw.Draw(strip)
    d.rectangle([0, 0, length, strip.height], fill=YELLOW)
    if stitch:
        m = max(4, int(band * 0.08))
        d.line([(0, m), (length, m)], fill=EDGE, width=2)
        d.line([(0, strip.height - m - 2), (length, strip.height - m - 2)], fill=EDGE, width=2)
    # Text: as big as fits the band height and the visible part of the ribbon.
    centre_c = (inner + outer) / 2
    # Visible chord on the inner (shorter) side of the text: from x = c to the right edge.
    text_top_c = centre_c + band * 0.3 * 2**0.5
    chord = (w - text_top_c) * 2**0.5
    size = int(band * 0.62)
    while size > 10:
        font = ImageFont.truetype(FONT, size)
        l, t, r, b = d.textbbox((0, 0), "UPDATED", font=font)
        if r - l <= chord * 0.86 and b - t <= band * 0.6:
            break
        size -= 1
    l, t, r, b = d.textbbox((0, 0), "UPDATED", font=font)
    d.text(((length - (r - l)) / 2 - l, (strip.height - (b - t)) / 2 - t), "UPDATED", font=font, fill=TEXT)

    rot = strip.rotate(-45, resample=Image.BICUBIC, expand=True)
    # Centre of the strip goes to the point (w - k, k) of the line x - y = centre_c.
    k = (w - centre_c) / 2
    cx, cy = w - k, k
    pos = (int(round(cx - rot.width / 2)), int(round(cy - rot.height / 2)))

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shadow = Image.new("RGBA", rot.size, (0, 0, 0, 0))
    shadow.putalpha(rot.getchannel("A").point(lambda a: int(a * 0.45)))
    layer.alpha_composite(shadow, (pos[0] + 3, pos[1] + 5))
    layer = layer.filter(ImageFilter.GaussianBlur(5))
    layer.alpha_composite(rot, pos)
    out = img.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


def main() -> None:
    src = Image.open(SRC)
    src.load()
    base = src.convert("RGB")
    for name, v in VARIANTS.items():
        res = ribbon(base, v["inner"], v["outer"], v["stitch"])
        path = os.path.join(HERE, f"cover-updated-{name}.png")
        res.save(path, optimize=True)
        size = os.path.getsize(path)
        # Pixels outside the ribbon must be the original's.
        diff = [(x, y) for y in range(0, base.height, 4) for x in range(0, base.width, 4) if res.getpixel((x, y)) != base.getpixel((x, y))]
        far = [p for p in diff if p[0] - p[1] < v["inner"] - 30]
        print(f"{os.path.basename(path)}: {res.size[0]}x{res.size[1]}, {size / 1024:.0f} KB, changed samples {len(diff)}, outside ribbon {len(far)}")
        if size >= 1024 * 1024:
            sys.exit(f"{path} is 1 MB or bigger")
        if far:
            sys.exit(f"{path}: pixels changed outside the ribbon")


if __name__ == "__main__":
    main()
