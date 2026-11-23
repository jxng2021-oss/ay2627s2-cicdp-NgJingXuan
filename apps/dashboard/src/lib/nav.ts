import type { IconName } from "@/components/icons";
import type { FeatureId } from "./features";

export interface NavLink {
  path: string;
  label: string;
}

export interface NavItem extends NavLink {
  icon: IconName;
  feature?: FeatureId;
  children?: NavLink[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const WORKSPACE_NAV: NavGroup[] = [
  {
    label: "General",
    items: [{ path: "", label: "Overview", icon: "overview" }],
  },
  {
    label: "Access",
    items: [
      { path: "/api-keys", label: "API keys", icon: "keys", feature: "keys" },
      {
        path: "/secrets",
        label: "Secrets",
        icon: "secrets",
        feature: "secrets",
      },
      {
        path: "/connections",
        label: "Connections",
        icon: "connections",
        feature: "connections",
      },
    ],
  },
  {
    label: "App services",
    items: [
      {
        path: "/user-pools",
        label: "User pools",
        icon: "users",
        feature: "pools",
        children: [
          { path: "/user-pools", label: "Users" },
          { path: "/user-logs", label: "User logs" },
        ],
      },
      {
        path: "/flags",
        label: "Feature flags",
        icon: "flag",
        feature: "flags",
      },
    ],
  },
  {
    label: "Data",
    items: [
      { path: "/files", label: "Files", icon: "files", feature: "files" },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { path: "/audit", label: "Audit log", icon: "audit", feature: "audit" },
    ],
  },
  {
    label: "Manage",
    items: [{ path: "/settings", label: "Settings", icon: "settings" }],
  },
];
