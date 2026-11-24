import type { IconName } from "@/components/icons";
import type { FeatureId } from "./features";

export interface NavLink {
  path: string;
  label: string;
  icon: IconName;
}

export interface NavItem extends NavLink {
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
        label: "Third-party services",
        icon: "services",
        feature: "connections",
        children: [
          { path: "/connections", label: "Connections", icon: "connections" },
          { path: "/webhooks", label: "Webhooks", icon: "webhooks" },
        ],
      },
    ],
  },
  {
    label: "App services",
    items: [
      {
        path: "/user-pools",
        label: "User management",
        icon: "users",
        feature: "pools",
        children: [
          { path: "/user-pools", label: "User pools", icon: "pool" },
          { path: "/user-logs", label: "User activity", icon: "activity" },
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
