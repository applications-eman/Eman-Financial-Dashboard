// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${data.x}" and "${form.x}" are Meta Flow expressions, not JavaScript templates
// The Flow definition uploaded to Meta (Flow JSON 6.0, data endpoint 3.0). Generated, so tests can check it.
import { existsSync, readFileSync } from "node:fs";

export interface Banners {
  /** base64 JPEG, 3:1, first screen */
  tall: string;
  /** base64 JPEG, 5:1, other screens */
  slim: string;
}

/** The branded banners (docs/whatsapp-invoicing/banner.jpg and banner-slim.jpg, made by scripts/make-banner.py). None without the files. */
export function loadBanners(): Banners | null {
  const read = (name: string) => {
    const url = new URL(`../../../docs/whatsapp-invoicing/${name}`, import.meta.url);
    return existsSync(url) ? readFileSync(url).toString("base64") : null;
  };
  const tall = read("banner.jpg");
  const slim = read("banner-slim.jpg");
  return tall && slim ? { tall, slim } : null;
}

/**
 * A banner across the screen. Meta advises giving width, height and aspect ratio together (without them the preview and some
 * phones show a square). 360 points is the width of a normal phone screen; the picture scales down on narrower ones.
 */
const banner = (src: string | null, aspectRatio: number) =>
  src
    ? [
        {
          type: "Image",
          src,
          width: 360,
          height: Math.round(360 / aspectRatio),
          "scale-type": "contain",
          "aspect-ratio": aspectRatio,
          "alt-text": "Eman Bakery, taste of tradition since 2007",
        },
      ]
    : [];

const heading = (text: string) => ({ type: "TextHeading", text });
const body = (text: string) => ({ type: "TextBody", text });
const subheading = (text: string) => ({ type: "TextSubheading", text });
const caption = (text: string) => ({ type: "TextCaption", text });
const dataExchange = (payload: Record<string, string>) => ({ name: "data_exchange", payload });

const optionArray = (example: unknown[]) => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      image: { type: "string" },
      "alt-text": { type: "string" },
    },
  },
  __example__: example,
});
const str = (example: string) => ({ type: "string", __example__: example });
const bool = (example: boolean) => ({ type: "boolean", __example__: example });

export function buildFlowJson(banners: Banners | null = loadBanners()) {
  return {
    version: "6.0",
    data_api_version: "3.0",
    routing_model: { CUSTOMER: ["ITEMS"], ITEMS: ["REVIEW"], REVIEW: [] },
    screens: [
      {
        id: "CUSTOMER",
        title: "Customer",
        refresh_on_back: true,
        data: {
          customers: optionArray([{ id: "c1", title: "Al Noor Supermarket" }]),
          use_ticks: bool(true),
          use_list: bool(false),
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            ...banner(banners?.tall ?? null, 3),
            heading("Create invoice"),
            subheading("Step 1 of 3 • Select customer"),
            {
              type: "RadioButtonsGroup",
              label: "Customer",
              name: "customer",
              required: "${data.use_ticks}",
              visible: "${data.use_ticks}",
              "data-source": "${data.customers}",
            },
            {
              type: "Dropdown",
              label: "Customer",
              name: "customer_pick",
              required: "${data.use_list}",
              visible: "${data.use_list}",
              "data-source": "${data.customers}",
            },
            caption("Choose from your assigned customers"),
            {
              type: "Footer",
              label: "Next",
              "on-click-action": dataExchange({
                step: "select_customer",
                customer: "${form.customer}",
                customer_pick: "${form.customer_pick}",
              }),
            },
          ],
        },
      },
      {
        id: "ITEMS",
        title: "Invoice",
        refresh_on_back: true,
        data: {
          categories: optionArray([{ id: "k1", title: "Shami" }]),
          products: optionArray([{ id: "p1", title: "SHAMI - 5", description: "Maximum 4.50 before VAT" }]),
          selected: str("p1"),
          use_ticks: bool(true),
          use_list: bool(false),
          cart_text: str("Your cart is empty."),
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            ...banner(banners?.slim ?? null, 5),
            subheading("Step 2 of 3 • Add products"),
            {
              type: "EmbeddedLink",
              text: "Open cart / edit ›",
              "on-click-action": dataExchange({ step: "open_cart" }),
            },
            body("${data.cart_text}"),
            {
              type: "Dropdown",
              label: "Category",
              name: "category",
              required: true,
              "data-source": "${data.categories}",
              "on-select-action": dataExchange({ step: "select_category", category: "${form.category}" }),
            },
            {
              type: "RadioButtonsGroup",
              label: "Product",
              name: "product",
              required: "${data.use_ticks}",
              visible: "${data.use_ticks}",
              "data-source": "${data.products}",
              "init-value": "${data.selected}",
              "on-select-action": dataExchange({
                step: "select_product",
                category: "${form.category}",
                product: "${form.product}",
              }),
            },
            {
              type: "Dropdown",
              label: "Product",
              name: "product_pick",
              required: "${data.use_list}",
              visible: "${data.use_list}",
              "data-source": "${data.products}",
            },
            {
              type: "EmbeddedLink",
              text: "Show all products again",
              "on-click-action": dataExchange({ step: "select_category", category: "${form.category}" }),
            },
            { type: "TextInput", label: "Quantity", name: "qty", "input-type": "number", required: true },
            { type: "TextInput", label: "Price before VAT", name: "price", "input-type": "number", required: true },
            {
              type: "Footer",
              label: "Add to cart",
              "on-click-action": dataExchange({
                step: "add_item",
                category: "${form.category}",
                product: "${form.product}",
                product_pick: "${form.product_pick}",
                qty: "${form.qty}",
                price: "${form.price}",
              }),
            },
          ],
        },
      },
      {
        id: "REVIEW",
        title: "Check invoice",
        terminal: true,
        data: { review_text: str("Customer: Al Noor Supermarket\n\n1. SHAMI - 5\n     20 x 4.35 = 87.00") },
        layout: {
          type: "SingleColumnLayout",
          children: [
            ...banner(banners?.slim ?? null, 5),
            subheading("Step 3 of 3 • Review and send"),
            body("${data.review_text}"),
            {
              type: "EmbeddedLink",
              text: "Remove last product",
              "on-click-action": dataExchange({ step: "remove_last" }),
            },
            caption("The invoice goes to ZATCA and the PDF arrives in this chat"),
            { type: "Footer", label: "Send invoice", "on-click-action": dataExchange({ step: "confirm" }) },
          ],
        },
      },
    ],
  };
}
