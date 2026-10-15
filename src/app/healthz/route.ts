// Cloud Run health check. Intentionally public, dependency-free and cheap.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "eman-expenses-dashboard" }, { headers: { "Cache-Control": "no-store" } });
}
