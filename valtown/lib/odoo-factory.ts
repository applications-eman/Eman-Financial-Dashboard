// Single place that builds the Odoo reader; tests replace it with a fake.
import { type OdooReader, OdooClient, odooConfigFromEnv, odooConfigured } from "./odoo.ts";

let override: OdooReader | null = null;
export const setOdoo = (o: OdooReader | null) => { override = o; };
export const odooAvailable = () => override != null || odooConfigured();
export const getOdoo = (): OdooReader => override ?? new OdooClient(odooConfigFromEnv());
