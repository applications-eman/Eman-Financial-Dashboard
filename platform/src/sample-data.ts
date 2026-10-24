// A small set of clearly named TEST customers, categories and products, so the WhatsApp form can be tried with realistic lists.
// Only in test mode. The same names must exist in Odoo (the platform links them by name).
export const SAMPLE_CUSTOMERS = [
  "TEST Customer 1 - Al Noor Market",
  "TEST Customer 2 - Baraka Grocery",
  "TEST Customer 3 - Corniche Cafe",
  "TEST Customer 4 - Dana Mini Market",
  "TEST Customer 5 - Hay Al Salama Bakery",
  "TEST Customer 6 - Sultan Restaurant",
  "TEST Customer 7 - Zahra Supermarket",
];

export const SAMPLE_CATEGORIES: { name: string; products: [string, number][] }[] = [
  {
    name: "TEST Arabic Bread",
    products: [
      ["TEST Arabic Bread Large", 3.5],
      ["TEST Arabic Bread Small", 2.2],
      ["TEST Whole Wheat Bread", 4],
      ["TEST Saj Bread", 3],
      ["TEST Mini Pita", 1.8],
    ],
  },
  {
    name: "TEST Cakes",
    products: [
      ["TEST Chocolate Cake", 24],
      ["TEST Date Cake", 18],
      ["TEST Vanilla Cake", 20],
      ["TEST Carrot Cake", 22],
      ["TEST Cheese Cake", 28],
    ],
  },
  {
    name: "TEST Samoli",
    products: [
      ["TEST Samoli Plain", 1.6],
      ["TEST Samoli Sesame", 1.8],
      ["TEST Hot Dog Bun", 1.5],
      ["TEST Burger Bun", 1.7],
      ["TEST Cheese Bun", 2.4],
    ],
  },
  {
    name: "TEST Shami",
    products: [
      ["TEST Shami 5 pcs", 4.5],
      ["TEST Shami 10 pcs", 8.5],
      ["TEST Shami Sesame 5 pcs", 5],
      ["TEST Shami Wheat 10 pcs", 9.5],
      ["TEST Shami 20 pcs", 16],
    ],
  },
];
