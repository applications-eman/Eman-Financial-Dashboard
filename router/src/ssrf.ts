/**
 * A target address is typed in by an admin, so it must never reach internal systems.
 * Only public https addresses are accepted: no http, no IP addresses, no localhost or internal names.
 */
export function isSafeTargetUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".")) return false; // "localhost", "metadata", single-label internal names
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false; // IPv4 / IPv6 literals
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  if (host === "metadata.google.internal") return false;
  return true;
}
