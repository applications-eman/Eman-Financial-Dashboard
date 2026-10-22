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
        refresh_on_back: true,
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
              "on-click-action": dataExchange({ step: "select_customer", customer: "${form.customer}" }),
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
          cart_text: str("Your cart is empty."),
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "EmbeddedLink",
              text: "Open cart / edit ›",
              "on-click-action": dataExchange({ step: "open_cart" }),
            },
            body("${data.cart_text}"),
            {
              type: "RadioButtonsGroup",
              label: "Category",
              name: "category",
              required: false,
              "data-source": "${data.categories}",
              "on-select-action": dataExchange({ step: "select_category", category: "${form.category}" }),
            },
            {
              type: "Dropdown",
              label: "Product",
              name: "product",
              required: false,
              "data-source": "${data.products}",
            },
            { type: "TextInput", label: "Quantity", name: "qty", "input-type": "number", required: false },
            { type: "TextInput", label: "Price before VAT", name: "price", "input-type": "number", required: false },
            {
              type: "Footer",
              label: "Add to cart",
              "on-click-action": dataExchange({
                step: "add_item",
                category: "${form.category}",
                product: "${form.product}",
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
            body("${data.review_text}"),
            {
              type: "EmbeddedLink",
              text: "Remove last product",
              "on-click-action": dataExchange({ step: "remove_last" }),
            },
            { type: "Footer", label: "Create invoice", "on-click-action": dataExchange({ step: "confirm" }) },
          ],
        },
      },
    ],
  };
}
