// Runtime configuration for the browser. NEXT_PUBLIC_* values would normally be inlined at BUILD time; reading them
// through a dynamic key on the server and handing them to the browser via window.__ENV__ lets one Docker image run
// with whatever Cloud Run injects from Secret Manager at deploy time. None of these values are secrets
// (the anon key is public by design; RLS is the protection). The service role key is never referenced here.
export interface PublicEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ADMIN_API_URL: string;
  /** platform service (WhatsApp invoicing admin); empty until it is deployed */
  PLATFORM_API_URL: string;
}

declare global {
  interface Window {
    __ENV__?: PublicEnv;
  }
}

const read = (key: string) => process.env[key] ?? "";

export function readServerPublicEnv(): PublicEnv {
  return {
    SUPABASE_URL: read("NEXT_PUBLIC_SUPABASE_URL"),
    SUPABASE_ANON_KEY: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    ADMIN_API_URL: read("NEXT_PUBLIC_ADMIN_API_URL").replace(/\/$/, ""),
    PLATFORM_API_URL: read("NEXT_PUBLIC_PLATFORM_API_URL").replace(/\/$/, ""),
  };
}

export function getPublicEnv(): PublicEnv {
  if (typeof window !== "undefined" && window.__ENV__) return window.__ENV__;
  return readServerPublicEnv();
}
