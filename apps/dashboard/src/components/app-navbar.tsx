"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AccountDialog } from "@/components/account-dialog";
import { Icon, type IconName } from "@/components/icons";
import type { Me } from "@/lib/api/client";
import { auth } from "@/lib/api/endpoints";
import { useMarkSignedIn } from "@/lib/session";
import { applyTheme, currentTheme, type Theme } from "@/lib/theme";

function Dropdown({
  button,
  align = "start",
  children,
}: {
  button: ReactNode;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="navbar-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {button}
        <Icon name="chevron-down" size={14} />
      </button>
      <div
        className="dropdown-panel"
        id={panelId}
        data-align={align}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(currentTheme()), []);
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={theme === option.value}
          title={`${option.label} theme`}
          onClick={() => {
            applyTheme(option.value);
            setTheme(option.value);
          }}
        >
          <Icon name={option.icon} size={15} />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

const initial = (text: string) => text.trim().charAt(0).toUpperCase() || "?";

export function AppNavbar({
  me,
  workspaceId,
  menuOpen,
  onToggleMenu,
  onMeChanged,
}: {
  me: Me;
  workspaceId?: string;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  onMeChanged?: () => void;
}) {
  const router = useRouter();
  const markSignedIn = useMarkSignedIn();
  const current = me.workspaces.find((w) => w.id === workspaceId);
  const [accountOpen, setAccountOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setAccountOpen(false), [pathname]);
  const who = me.user.displayName ?? me.user.email;

  async function logOut() {
    await auth.logout().catch(() => undefined);
    markSignedIn(false);
    router.replace("/login");
  }

  return (
    <>
      <header className="navbar">
        <div className="navbar-start">
          {onToggleMenu && (
            <button
              type="button"
              className="navbar-button navbar-menu"
              aria-expanded={menuOpen}
              aria-controls="sidebar"
              onClick={onToggleMenu}
            >
              <Icon name="menu" />
              <span className="sr-only">
                {menuOpen ? "Close menu" : "Open menu"}
              </span>
            </button>
          )}
          <Link className="wordmark" href="/">
            secure-cloud
          </Link>
          {current && (
            <>
              <span className="navbar-divider" aria-hidden="true">
                /
              </span>
              <Dropdown
                button={
                  <>
                    <span className="sr-only">Workspace: </span>
                    <span className="avatar" aria-hidden="true">
                      {initial(current.name)}
                    </span>
                    <span className="navbar-workspace">{current.name}</span>
                    <span className="pill navbar-role">
                      {current.role === "owner" ? "Owner" : "Member"}
                    </span>
                    <span className="sr-only">, switch workspace</span>
                  </>
                }
              >
                <p className="eyebrow">Switch workspace</p>
                <ul className="dropdown-list">
                  {me.workspaces.map((w) => (
                    <li key={w.id}>
                      <Link
                        href={`/workspaces/${w.id}`}
                        aria-current={w.id === workspaceId ? "page" : undefined}
                      >
                        <span className="avatar" aria-hidden="true">
                          {initial(w.name)}
                        </span>
                        <span className="dropdown-item-text">{w.name}</span>
                        <span className="muted dropdown-item-meta">
                          {w.role === "owner" ? "Owner" : "Member"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="dropdown-footer">
                  <Link href="/workspaces">
                    <Icon name="plus" size={14} />
                    All workspaces and new workspace
                  </Link>
                </div>
              </Dropdown>
            </>
          )}
        </div>
        <div className="navbar-end">
          <ThemeSwitch />
          <Dropdown
            align="end"
            button={
              <>
                <span className="sr-only">Account: </span>
                <span className="avatar" data-kind="user" aria-hidden="true">
                  {initial(who)}
                </span>
                <span className="navbar-user">{who}</span>
              </>
            }
          >
            <div className="dropdown-header">
              {me.user.displayName && (
                <p className="dropdown-item-text">{me.user.displayName}</p>
              )}
              <p className="muted user-email">{me.user.email}</p>
            </div>
            <ul className="dropdown-list">
              <li>
                <button type="button" onClick={() => setAccountOpen(true)}>
                  Account
                </button>
              </li>
              <li>
                <Link href="/workspaces">Your workspaces</Link>
              </li>
            </ul>
            <div className="dropdown-footer">
              <button type="button" onClick={() => void logOut()}>
                Log out
              </button>
            </div>
          </Dropdown>
        </div>
      </header>
      <AccountDialog
        me={me}
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        onChanged={() => onMeChanged?.()}
      />
    </>
  );
}
