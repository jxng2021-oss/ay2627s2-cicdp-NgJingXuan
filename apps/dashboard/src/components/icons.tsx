import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CaretDown,
  Check,
  Copy,
  Files,
  Flag,
  GearSix,
  Key,
  List,
  ListMagnifyingGlass,
  LockKey,
  Monitor,
  Moon,
  PlugsConnected,
  Plus,
  ShieldCheck,
  SquaresFour,
  Sun,
  Users,
  X,
} from "@phosphor-icons/react/ssr";

const ICONS = {
  overview: SquaresFour,
  keys: Key,
  secrets: LockKey,
  connections: PlugsConnected,
  files: Files,
  audit: ListMagnifyingGlass,
  settings: GearSix,
  shield: ShieldCheck,
  check: Check,
  users: Users,
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
