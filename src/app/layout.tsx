import type { ReactNode } from "react";

import type { Metadata } from "next";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_CONFIG } from "@/config/app-config";
import { fontVars } from "@/lib/fonts/registry";
import { dirOf } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/provider";
import { getLang } from "@/lib/i18n/server";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { readServerPublicEnv } from "@/lib/public-env";
import { ThemeBootScript } from "@/scripts/theme-boot";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: APP_CONFIG.meta.title,
  description: APP_CONFIG.meta.description,
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { theme_mode, theme_preset, content_layout, navbar_style, sidebar_variant, sidebar_collapsible, font } =
    PREFERENCE_DEFAULTS;
  const lang = await getLang(); // reads cookies => the layout is rendered per request, so runtime env is always fresh
  const publicEnv = JSON.stringify(readServerPublicEnv()).replace(/</g, "\\u003c");
  return (
    <html
      lang={lang}
      dir={dirOf(lang)}
      data-theme-mode={theme_mode}
      data-theme-preset={theme_preset}
      data-content-layout={content_layout}
      data-navbar-style={navbar_style}
      data-sidebar-variant={sidebar_variant}
      data-sidebar-collapsible={sidebar_collapsible}
      data-font={font}
      suppressHydrationWarning
    >
      <head>
        {/* Runtime public config (Supabase URL / anon key / admin API URL). Not secrets. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output with "<" escaped
          dangerouslySetInnerHTML={{ __html: `window.__ENV__=${publicEnv};` }}
        />
        {/* Applies theme and layout preferences on load to avoid flicker and unnecessary server rerenders. */}
        <ThemeBootScript />
      </head>
      <body className={`${fontVars} min-h-screen antialiased`}>
        <TooltipProvider>
          <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS}>
            <I18nProvider initialLang={lang}>
              {children}
              <Toaster />
            </I18nProvider>
          </PreferencesStoreProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
