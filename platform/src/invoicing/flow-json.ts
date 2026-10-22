// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${data.x}" and "${form.x}" are Meta Flow expressions, not JavaScript templates
// The Flow definition uploaded to Meta (Flow JSON 6.0, data endpoint 3.0). Generated, so tests can check it.
const heading = (text: string) => ({ type: "TextHeading", text });
const body = (text: string) => ({ type: "TextBody", text });
const dataExchange = (payload: Record<string, string>) => ({ name: "data_exchange", payload });

const optionArray = (example: unknown[]) => ({
  type: "array",
  items: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
  },
  __example__: example,
});
const str = (example: string) => ({ type: "string", __example__: example });

export function buildFlowJson() {
  return {
    version: "6.0",
    data_api_version: "3.0",
    routing_model: { CUSTOMER: ["ITEMS"], ITEMS: ["REVIEW"], REVIEW: [] },
    screens: [
      {
        id: "CUSTOMER",
        title: "Customer",
        data: { customers: optionArray([{ id: "c1", title: "Al Noor Supermarket" }]) },
        layout: {
          type: "SingleColumnLayout",
          children: [
            heading("Choose the customer"),
            {
              type: "Dropdown",
              label: "Customer",
              name: "customer",
              required: true,
              "data-source": "${data.customers}",
            },
            {
              type: "Footer",
              label: "Continue",
              "on-click-action": dataExchange({ action: "select_customer", customer: "${form.customer}" }),
            },
          ],
        },
      },
      {
        id: "ITEMS",
        title: "Invoice",
        data: {
          categories: optionArray([{ id: "k1", title: "Shami" }]),
          products: optionArray([{ id: "p1", title: "SHAMI - 5", description: "Maximum 4.50 before VAT" }]),
          cart_text: str("Your cart is empty."),
          category_init: str(""),
          product_init: str(""),
          qty_init: str(""),
          price_init: str(""),
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            heading("Your invoice"),
            body("${data.cart_text}"),
            {
              type: "Dropdown",
              label: "Category",
              name: "category",
              required: false,
              "data-source": "${data.categories}",
              "init-value": "${data.category_init}",
              "on-select-action": dataExchange({ action: "select_category", category: "${form.category}" }),
            },
            {
              type: "Dropdown",
              label: "Product",
              name: "product",
              required: false,
              "data-source": "${data.products}",
              "init-value": "${data.product_init}",
            },
            {
              type: "TextInput",
              label: "Quantity",
              name: "qty",
              "input-type": "number",
              required: false,
              "init-value": "${data.qty_init}",
            },
            {
              type: "TextInput",
              label: "Price before VAT",
              name: "price",
              "input-type": "number",
              required: false,
              "init-value": "${data.price_init}",
            },
            {
              type: "RadioButtonsGroup",
              label: "What next?",
              name: "after",
              required: true,
              "init-value": "add_more",
              "data-source": [
                { id: "add_more", title: "Add and add another product" },
                { id: "add_review", title: "Add and go to review" },
                { id: "review_only", title: "Go to review" },
                { id: "remove_last", title: "Remove the last product" },
              ],
            },
            {
              type: "Footer",
              label: "Continue",
              "on-click-action": dataExchange({
                action: "submit_item",
                category: "${form.category}",
                product: "${form.product}",
                qty: "${form.qty}",
                price: "${form.price}",
                after: "${form.after}",
              }),
            },
          ],
        },
      },
      {
        id: "REVIEW",
        title: "Please check",
        terminal: true,
        data: { review_text: str("Customer: Al Noor Supermarket\n\n1. SHAMI - 5: 20 x 4.35 = 87.00") },
        layout: {
          type: "SingleColumnLayout",
          children: [
            heading("Please check"),
            body("${data.review_text}"),
            { type: "Footer", label: "Confirm invoice", "on-click-action": dataExchange({ action: "confirm" }) },
          ],
        },
      },
    ],
  };
}
