import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createServerClient } from "@supabase/ssr";

import { readServerPublicEnv } from "@/lib/public-env";

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const env = readServerPublicEnv();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // called from a Server Component: the proxy refreshes the session instead
        }
      },
    },
  });
}

export type StaffRole = "admin" | "accounts";

export interface AdminProfile {
  authUserId: string;
  email: string;
  name: string;
  role: StaffRole;
}

/** Returns the signed-in admin or accounts user, or the reason they cannot enter. */
export async function getAdminProfile(): Promise<
  { ok: true; profile: AdminProfile } | { ok: false; reason: "anonymous" | "not_admin" }
> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return { ok: false, reason: "anonymous" };
  // RLS policy self_select lets a user read only their own app_users row (never token_hash)
  const { data: row } = await supabase
    .from("app_users")
    .select("name, role, active")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!row || !row.active || (row.role !== "admin" && row.role !== "accounts"))
    return { ok: false, reason: "not_admin" };
  return { ok: true, profile: { authUserId: user.id, email: user.email ?? "", name: row.name, role: row.role } };
}

/** Pages that only admins may open. Accounts users are sent to their own page. */
export async function requireAdmin(): Promise<AdminProfile> {
  const gate = await getAdminProfile();
  if (!gate.ok) redirect(gate.reason === "anonymous" ? "/auth/login" : "/unauthorized");
  if (gate.profile.role !== "admin") redirect("/dashboard/alerts");
  return gate.profile;
}
