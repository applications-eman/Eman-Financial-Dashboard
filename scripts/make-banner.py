"""Prepares the Flow banners from the artwork the owner supplied (2000 x 667, 3:1).
  python3 scripts/make-banner.py <rich-banner> <logo-on-green-banner>
- docs/whatsapp-invoicing/banner.jpg       1080 x 360 (3:1), first screen: the rich artwork, scaled down
- docs/whatsapp-invoicing/banner-slim.jpg  1080 x 216 (5:1), other screens: the logo from the green artwork on its own green
Needs Pillow. Each file is kept under 100 KB (the Flow limit is 300 KB)."""
import io
import sys

from PIL import Image

OUT = "docs/whatsapp-invoicing/"


def save(img: Image.Image, name: str, limit: int = 100_000) -> None:
    for q in (90, 85, 80, 75, 70, 62, 55):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
        if len(buf.getvalue()) <= limit:
            break
    open(OUT + name, "wb").write(buf.getvalue())
    print(name, img.size, len(buf.getvalue()), "bytes, quality", q)


rich = Image.open(sys.argv[1]).convert("RGB")
save(rich.resize((1080, 360), Image.LANCZOS), "banner.jpg")

green = Image.open(sys.argv[2]).convert("RGB")
w, h = green.size
# the plain background colour: the average of a strip along the left edge
strip = green.crop((0, 0, 60, h)).resize((1, 1), Image.BOX).getpixel((0, 0))
logo = green.crop((int(w * 0.27), int(h * 0.10), int(w * 0.73), int(h * 0.93)))  # the emblem and a little green around it
canvas = Image.new("RGB", (1080, 216), strip)
lh = 200
lw = round(logo.width * lh / logo.height)
canvas.paste(logo.resize((lw, lh), Image.LANCZOS), ((1080 - lw) // 2, 8))
save(canvas, "banner-slim.jpg")
