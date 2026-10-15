// Decode a QR code from a photo (JPEG/PNG). Deno-compatible: pure-JS decoders only.
// Strategy: grayscale -> several scales -> optional contrast stretch / inversion -> jsQR.
import jsQR from "npm:jsqr@1.4.0";
import jpeg from "npm:jpeg-js@0.4.4";
import { PNG } from "npm:pngjs@7.0.0";

interface Img { data: Uint8ClampedArray; width: number; height: number }

export function decodeImage(bytes: Uint8Array): Img {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (isPng) {
    const p = PNG.sync.read(Buffer.from(bytes));
    return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
  }
  if (isJpg) {
    const j = jpeg.decode(Buffer.from(bytes), { useTArray: true, maxMemoryUsageInMB: 512 });
    return { data: new Uint8ClampedArray(j.data), width: j.width, height: j.height };
  }
  throw new Error("Unsupported image type (need JPEG or PNG)");
}

function scale(img: Img, factor: number): Img {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  if (w === img.width) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / factor));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

function grayscale(img: Img, stretch: boolean): Img {
  const out = new Uint8ClampedArray(img.data.length);
  let lo = 255, hi = 0;
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    const v = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
    g[p] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    const v = stretch ? ((g[p] - lo) * 255) / range : g[p];
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

export function decodeQrFromImage(bytes: Uint8Array): string | null {
  const base = decodeImage(bytes);
  const longest = Math.max(base.width, base.height);
  const factors = [1, 0.5, 0.35, 0.75, 1.5].filter((f) => longest * f >= 200 && longest * f <= 4000);
  for (const f of factors) {
    const scaled = scale(base, f);
    for (const stretch of [false, true]) {
      const gray = grayscale(scaled, stretch);
      const hit = jsQR(gray.data, gray.width, gray.height, { inversionAttempts: "attemptBoth" });
      if (hit?.data) return hit.data;
    }
  }
  return null;
}
