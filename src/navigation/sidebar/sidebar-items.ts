import {
  Croissant,
  Download,
  History,
  LayoutDashboard,
  type LucideIcon,
  Settings,
  ShoppingBasket,
  Tags,
  ToggleRight,
  Users,
} from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  /** i18n key suffix: nav.group.<groupKey> */
  groupKey: string;
  label?: string;
  items: NavMainItem[];
}

// `title` is the English fallback; the sidebar renders t(`nav.${id}`).
export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    groupKey: "overview",
    items: [
      { id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      { id: "bakery", title: "Bakery Expenses", url: "/dashboard/bakery", icon: Croissant },
      { id: "grocery", title: "Grocery Expenses", url: "/dashboard/grocery", icon: ShoppingBasket },
    ],
  },
  {
    id: 2,
    groupKey: "management",
    items: [
      { id: "users", title: "Users", url: "/dashboard/users", icon: Users },
      { id: "categories", title: "Categories", url: "/dashboard/categories", icon: Tags },
      { id: "settings", title: "Settings", url: "/dashboard/settings", icon: Settings },
      { id: "flags", title: "Feature Flags", url: "/dashboard/flags", icon: ToggleRight },
      { id: "audit", title: "Audit Log", url: "/dashboard/audit", icon: History },
      { id: "exports", title: "Exports", url: "/dashboard/exports", icon: Download },
    ],
  },
];
