// Structured JSON logging. Anything that looks like a secret is redacted before it is written.
const SENSITIVE = /(token|secret|key|authorization|password|passphrase|signature|cookie|jwt|hash)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…[${value.length}]`;
  return value;
}

export function maskPhone(p: string | undefined): string | undefined {
  return p ? `${p.slice(0, 4)}…${p.slice(-3)}` : p;
}

type Level = "debug" | "info" | "warn" | "error";
export const sink: { write: (line: string) => void } = { write: (l) => console.log(l) };

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  sink.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) }));
}
export const logger = {
  info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
