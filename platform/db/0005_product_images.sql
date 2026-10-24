-- Small product pictures shown in the WhatsApp Flow (a base64 JPEG/PNG of at most about 20 KB). The platform also applies this on start.
alter table public.products add column if not exists image text check (image is null or length(image) <= 40000);
