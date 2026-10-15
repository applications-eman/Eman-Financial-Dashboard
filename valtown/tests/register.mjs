// Lets Node run Deno-style `npm:pkg@ver` specifiers used by the Val Town code.
import { register } from "node:module";
register("./npm-loader.mjs", import.meta.url);
