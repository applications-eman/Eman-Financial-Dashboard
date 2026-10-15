import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "Eman Expenses",
  version: packageJson.version,
  copyright: `© ${currentYear}, Eman Bakery.`,
  meta: {
    title: "Eman Expenses – Admin Console",
    description: "Live purchase-invoice capture and administration for Eman Bakery.",
  },
};
