# iOS Shortcut – scan an invoice QR and post it

The server accepts the **raw Base64 text of the QR code** and parses the five ZATCA fields itself, so the Shortcut stays
small. (Shortcut files are signed binaries, so they cannot be generated from this repository; build it once as below.)

You need: your **backend URL** (`https://applications--5ea60f0ec82c11f183e41607ee4eb77e.web.val.run` unless you set a custom
subdomain) and your personal **token** (Dashboard → Users → *Generate token*; shown once).

## Build it (Shortcuts app → + New Shortcut, name it “Invoice”)

1. **Choose from Menu** – prompt `Section?`, items `Bakery` and `Grocery`.
   - Under *Bakery*: **Text** `bakery` → **Set Variable** `section`.
   - Under *Grocery*: **Text** `grocery` → **Set Variable** `section`.
2. **Scan QR/Barcode** (action “Scan QR or Barcode”). Its result is the Base64 text printed on the invoice.
3. **Get Contents of URL**
   - URL: `<backend URL>/api/expense`
   - Method: `POST`, Request Body: `JSON`
   - Fields (all *Text*): `section` = variable **section**, `raw_qr` = **Scan QR/Barcode** result, `token` = your token.
4. **Get Dictionary Value** → key `status` from *Contents of URL* → **Set Variable** `status`.
5. **If** `status` **is** `saved` → **Show Notification** “Saved ✅”.
   **Otherwise, If** `status` **is** `duplicate` → **Show Notification** “Duplicate ⚠️ already recorded”.
   **Otherwise** → **Get Dictionary Value** `message` → **Show Alert** (the reason, e.g. “vat_number must be 15 digits”).
6. Tap ⓘ → **Add to Home Screen** for one-tap use.

Responses: `201 {status:"saved"}`, `200 {status:"duplicate"}`, `422 {status:"invalid", message}`, `401` bad token,
`403` section not allowed / channel switched off, `429` too many attempts.

## Optional: send the five fields instead of `raw_qr`

If a QR cannot be parsed you can send `seller_name`, `vat_number` (15 digits), `invoice_date` (`2026-08-11T15:19:20`),
`total_amount`, `vat_amount` as JSON text fields instead of `raw_qr`. Extracting them from the decoded QR inside Shortcuts
is fragile (the TLV length bytes are control characters) – prefer `raw_qr`. After *Base64 Decode*, `Match Text` with
`\d{15}` finds the VAT number and `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` the date, but amounts have no reliable pattern.

## Test from a computer

```bash
curl -s -X POST "$BACKEND/api/expense" -H 'content-type: application/json' \
  -d '{"section":"bakery","token":"eb_…","raw_qr":"<base64 from the invoice>"}'
```

Rotate the token from the Users page if a phone is lost; the old one stops working immediately.
