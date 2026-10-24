"""Builds the two Flow banners (full width, branded) from the logo: docs/whatsapp-invoicing/banner.jpg (tall, first screen)
and banner-slim.jpg (other screens). Needs Pillow:  python3 scripts/make-banner.py <logo.png>
The logo's white paper is removed (only the outside, the white inside the oval stays), then it is placed on a cream banner with the
brand green and gold."""
import io
import sys

from PIL import Image, ImageDraw, ImageFilter

LOGO = sys.argv[1]
OUT = "docs/whatsapp-invoicing/"
GREEN = (24, 99, 52)
GOLD = (232, 176, 46)
CREAM_TOP = (255, 248, 230)
CREAM_BOTTOM = (250, 236, 200)


def cut_out(path: str) -> Image.Image:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    mark = im.copy()
    key = (1, 254, 1)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(mark, seed, key, thresh=28)
    out = Image.new("RGBA", im.size)
    px, src, m = out.load(), im.load(), mark.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (*src[x, y], 0) if m[x, y] == key else (*src[x, y], 255)
    # soften the cut edge so no white fringe is left
    alpha = out.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out.putalpha(alpha)
    return out


def banner(logo: Image.Image, width: int, height: int, logo_h: int) -> Image.Image:
    img = Image.new("RGB", (width, height))
    d = ImageDraw.Draw(img)
    for y in range(height):
        t = y / max(1, height - 1)
        d.line([(0, y), (width, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(CREAM_TOP, CREAM_BOTTOM)))
    # a soft pattern of small gold grains along both sides
    for side in (0, 1):
        for i in range(9):
            for j in range(3):
                x = 30 + i * 22 + j * 9 if side == 0 else width - 30 - i * 22 - j * 9
                y = height // 2 + (i - 4) * 12 + (j - 1) * 14
                d.ellipse([x - 3, y - 6, x + 3, y + 6], fill=(*GOLD, 255) if False else GOLD if (i + j) % 3 == 0 else (240, 214, 140))
    ratio = logo_h / logo.height
    lg = logo.resize((round(logo.width * ratio), logo_h), Image.LANCZOS)
    img.paste(lg, ((width - lg.width) // 2, (height - 12 - logo_h) // 2), lg)
    d.rectangle([0, height - 12, width, height], fill=GREEN)
    d.rectangle([0, height - 12, width, height - 9], fill=GOLD)
    return img


def save(img: Image.Image, name: str) -> None:
    for q in (88, 80, 70, 60):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        if len(buf.getvalue()) <= 60_000:
            break
    open(OUT + name, "wb").write(buf.getvalue())
    print(name, img.size, len(buf.getvalue()), "bytes, quality", q)


logo = cut_out(LOGO)
save(banner(logo, 900, 300, 262), "banner.jpg")
save(banner(logo, 900, 180, 150), "banner-slim.jpg")
