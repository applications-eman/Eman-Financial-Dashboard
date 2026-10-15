"use client";

import { getPublicEnv } from "@/lib/public-env";
import { getSupabase } from "@/lib/supabase/client";

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** All dashboard WRITES go through the Val Town admin API with the user's Supabase JWT (audited server-side). */
export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AdminApiError("Not signed in", 401);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${getPublicEnv().ADMIN_API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      message = j.error ?? j.message ?? message;
    } catch {
      // keep status text
    }
    throw new AdminApiError(message, res.status);
  }
  return res;
}

export async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await adminFetch(path, init)).json() as Promise<T>;
}
export const adminSend = <T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
  adminJson<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
