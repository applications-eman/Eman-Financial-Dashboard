# Prompt for Meta AI (attach `flow-live.json` together with this text)

You are an expert in WhatsApp Flows (Flow JSON). I attach the Flow JSON of a live salesman invoicing form. Its backend is already built, tested and connected to a data endpoint. **Improve only how it looks and reads. Do not change how it works.**

## What the Flow does
A bakery salesman creates a tax invoice in three steps: (1) CUSTOMER: choose the customer; (2) ITEMS: choose a category, then a product, enter quantity and price, tap Add to cart (repeat for more products); (3) REVIEW: a receipt preview, then Send invoice. Screens are CUSTOMER, ITEMS, REVIEW (terminal). The backend answers every tap through `data_exchange`, so lists and texts come from `${data.*}`.

## What you MUST NOT change (the backend depends on all of it)
- `version` (6.0), `data_api_version` (3.0) and `routing_model`.
- Screen ids and their order: `CUSTOMER`, `ITEMS`, `REVIEW`. Do not add, remove, rename or reroute screens. Do not add a screen called `SUCCESS`.
- Every `name` of an input (`customer`, `customer_pick`, `category`, `product`, `product_pick`, `qty`, `price`).
- Every `data_exchange` action and its `payload` keys and values (`step`, `customer`, `customer_pick`, `category`, `product`, `product_pick`, `qty`, `price`).
- Every `${data.…}` binding and the `data` declarations of each screen, including the `__example__` values (keys: `customers`, `use_ticks`, `use_list`, `categories`, `products`, `selected`, `cart_text`, `review_text`). Do not rename them, change their types, or add new data keys.
- The expressions on `visible`, `required` and `init-value` (`${data.use_ticks}`, `${data.use_list}`, `${data.selected}`), the `on-select-action` of the Category dropdown and of the product list, and `refresh_on_back`.
- The number of footers: exactly one `Footer` per screen, with its action. You may change its label text only.
- `terminal: true` on REVIEW.

## What you MAY change (appearance and wording only)
- Wording of headings, subheadings, captions and the text of the footers and links. Keep the language English and short. Keep the three step lines "Step 1 of 3", "Step 2 of 3", "Step 3 of 3".
- Order and grouping of purely visual components (`TextHeading`, `TextSubheading`, `TextBody`, `TextCaption`), and the labels and helper text of inputs (a label must stay 20 characters or fewer).
- Add an `Image` component for a logo at the top of CUSTOMER: JPEG or PNG, base64, at most 300 KB, at most 3 images per screen, with `alt-text`, `scale-type` `contain`, and a fixed `width` and `height`. If you do not have the real logo, leave a clearly marked placeholder and tell me where to put it.
- Product pictures are already supported by the backend: each option of `data.products` may carry `image` (small base64, up to 100 KB) and `alt-text`. You may set `media-size` on the product list.
- Text styling that Flow JSON 6.0 allows (for example `font-weight`, `strikethrough` on text components, and markdown in `TextBody`).

## Hard Flow rules to respect
- Stay on Flow JSON 6.0. Do not use any component or property that needs a newer version.
- A required component cannot be invisible. Dynamic `required` is used for that reason, so leave those expressions alone.
- Option titles are 30 characters or fewer. A RadioButtonsGroup holds at most 20 options (the backend switches to a Dropdown for longer lists).
- The whole answer of the backend is limited to 1 MB, so never add large images to `data`.
- Do not use emoji in `label`, `title` or `data-source` option titles (they get truncated). Emoji are fine in captions if you must.

## What I want back
1. The complete improved Flow JSON in one code block (valid JSON, nothing omitted).
2. A short list of every change, grouped by screen.
3. A confirmation that you changed none of the items in "What you MUST NOT change", with a line-by-line check of the names and payload keys.
4. Any element you could not improve because of Flow limits, and why.

Goal of the design: look clean and branded for a bakery (calm, clear hierarchy, short wording), usable on a small phone with one hand, with the same behaviour as the file I attached.
