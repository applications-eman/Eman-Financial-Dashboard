"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/public-env";

let client: SupabaseClient | undefined;

/** Browser client: uses the logged-in admin's session, so every query is subject to RLS. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const env = getPublicEnv();
    client = createBrowserClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  }
  return client;
}
