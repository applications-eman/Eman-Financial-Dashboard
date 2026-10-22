"use client";

import { getPublicEnv } from "@/lib/public-env";
import { getSupabase } from "@/lib/supabase/client";

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

export const platformConfigured = () => getPublicEnv().PLATFORM_API_URL !== "";

/** Calls the platform service with the dashboard sign-in token. The service decides what the person may do. */
export async function platform<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = getPublicEnv().PLATFORM_API_URL;
  if (!base) throw new PlatformApiError("The platform service is not connected yet.", 0);
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new PlatformApiError("Please sign in again.", 401);
  const res = await fetch(`${base}/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { message?: string; error?: string }) | null;
  if (!res.ok) throw new PlatformApiError(json?.message ?? json?.error ?? res.statusText, res.status);
  return json as T;
}
