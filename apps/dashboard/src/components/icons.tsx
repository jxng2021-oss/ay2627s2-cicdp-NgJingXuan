import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CaretDown,
  Check,
  ClockCounterClockwise,
  Copy,
  Files,
  Flag,
  GearSix,
  GithubLogo,
  GoogleLogo,
  Info,
  Key,
  List,
  ListMagnifyingGlass,
  LockKey,
  Monitor,
  Moon,
  PlugsConnected,
  Plus,
  ShareNetwork,
  ShieldCheck,
  SquaresFour,
  Sun,
  Users,
  UsersThree,
  WebhooksLogo,
  X,
} from "@phosphor-icons/react/ssr";

const ICONS = {
  overview: SquaresFour,
  keys: Key,
  secrets: LockKey,
  connections: PlugsConnected,
  webhooks: WebhooksLogo,
  files: Files,
  audit: ListMagnifyingGlass,
  settings: GearSix,
  shield: ShieldCheck,
  check: Check,
  users: Users,
  info: Info,
  pool: UsersThree,
  activity: ClockCounterClockwise,
  services: ShareNetwork,
  flag: Flag,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  "chevron-down": CaretDown,
  plus: Plus,
  menu: List,
  close: X,
  replay: ArrowsClockwise,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  copy: Copy,
  google: GoogleLogo,
  github: GithubLogo,
} satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  weight = "regular",
}: {
  name: IconName;
  size?: number;
  weight?: "light" | "regular";
}) {
  const Component = ICONS[name];
  return (
    <Component
      size={size}
      weight={weight}
      aria-hidden="true"
      focusable="false"
    />
  );
}
