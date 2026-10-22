// Writes the Flow definition to docs/whatsapp-invoicing/flow-live.json (paste/upload it in Meta's Flow builder).
//   node src/invoicing/write-flow.ts   (then: npx biome format --write docs/whatsapp-invoicing/flow-live.json)

import { buildFlowJson } from "./flow-json.ts";
import { writeFileSync } from "node:fs";

const out = new URL("../../../docs/whatsapp-invoicing/flow-live.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(buildFlowJson(), null, 2)}\n`);
console.log(`written ${out.pathname}`);
