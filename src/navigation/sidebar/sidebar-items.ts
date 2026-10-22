import {
  AlertTriangle,
  Calculator,
  Croissant,
  Download,
  History,
  LayoutDashboard,
  type LucideIcon,
  MessageCircle,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Store,
  Tags,
  ToggleRight,
  TrendingUp,
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
  /** when set, only these roles see the item (default: everyone allowed in the dashboard) */
  roles?: ("admin" | "accounts")[];
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
      { id: "dashboard", title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, roles: ["admin"] },
      { id: "bakery", title: "Bakery Expenses", url: "/dashboard/bakery", icon: Croissant, roles: ["admin"] },
      { id: "grocery", title: "Grocery Expenses", url: "/dashboard/grocery", icon: ShoppingBasket, roles: ["admin"] },
    ],
  },
  {
    id: 3,
    groupKey: "revenue",
    items: [
      { id: "revenue", title: "Revenue", url: "/dashboard/revenue", icon: TrendingUp, roles: ["admin"] },
      { id: "grocerySales", title: "Grocery Sales", url: "/dashboard/grocery-sales", icon: Store, roles: ["admin"] },
      { id: "vat", title: "VAT Return", url: "/dashboard/vat", icon: Calculator, roles: ["admin"] },
    ],
  },
  {
    id: 4,
    groupKey: "monitoring",
    items: [
      { id: "alerts", title: "Alerts", url: "/dashboard/alerts", icon: AlertTriangle },
      { id: "zatca", title: "ZATCA", url: "/dashboard/zatca", icon: ShieldCheck },
    ],
  },
  {
    id: 2,
    groupKey: "management",
    items: [
      { id: "users", title: "Users", url: "/dashboard/users", icon: Users, roles: ["admin"] },
      { id: "platform", title: "WhatsApp Platform", url: "/dashboard/platform", icon: MessageCircle, roles: ["admin"] },
      { id: "categories", title: "Categories", url: "/dashboard/categories", icon: Tags, roles: ["admin"] },
      { id: "settings", title: "Settings", url: "/dashboard/settings", icon: Settings, roles: ["admin"] },
      { id: "flags", title: "Feature Flags", url: "/dashboard/flags", icon: ToggleRight, roles: ["admin"] },
      { id: "audit", title: "Audit Log", url: "/dashboard/audit", icon: History, roles: ["admin"] },
      { id: "exports", title: "Exports", url: "/dashboard/exports", icon: Download, roles: ["admin"] },
    ],
  },
];
