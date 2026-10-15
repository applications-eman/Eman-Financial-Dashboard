// Environment access that works on Deno (Val Town) and Node (tests). Never log values.
type G = typeof globalThis & {
  Deno?: { env: { get(k: string): string | undefined } };
  process?: { env: Record<string, string | undefined> };
};

export function env(name: string): string | undefined {
  const g = globalThis as G;
  const v = g.Deno ? g.Deno.env.get(name) : g.process?.env[name];
  return v === "" ? undefined : v;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const GRAPH_VERSION = env("WA_GRAPH_VERSION") ?? "v23.0";
