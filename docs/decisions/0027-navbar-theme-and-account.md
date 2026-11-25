# 0027: Navbar, theme switch and account management

- Status: Accepted
- Date: 2026-11-16

## Context

The owner asked for:

- the workspace name, role and switcher in a navbar on top, not the
  sidebar;
- a white theme they can pick;
- the audit log 15 events per page;
- secrets and connections lists with one "More Info" button per row
  instead of a row of actions;
- creating a connection on its own page (too much to fill in for a
  dialog);
- creating workspaces from the workspace picker;
- more on the Account page: a display name, the session list, the user's
  workspaces (with leaving one) and deleting the account;
- animated charts on the overview.

## Decision

- **Navbar + sidebar.** A sticky navbar (`components/app-navbar.tsx`) on
  every signed-in page shows the workspace (name, role, a switcher listing
  the user's workspaces), the theme switch and the account menu. The
  sidebar keeps only the page links. The menus are disclosures (a button
  with `aria-expanded` and a panel of links), closed by Escape, an outside
  click or navigating.
- **Theme switch (System / Light / Dark).** Stored in a plain cookie,
  `scp_theme` (a per-browser preference, nothing secret: never in
  localStorage with anything sensitive), read by the root layout and put on
  `<html data-theme>` on the server, so the first paint is already right.
  The OS dark-mode rules apply only when the choice isn't Light, and Dark
  reuses the dark tokens. The landing and auth pages stay dark.
- **Detail pages.** `secrets/[name]` (versions, rotate, delete) and
  `connections/[name]` (details, usage meters, policy editor, remove);
  `connections/new` is a three-step page. "new" is refused as a connection
  name in the dashboard (it would be hidden by the create page's URL).
- **Account routes** (`/dashboard/v1`, session and CSRF like every other
  dashboard change):
  - `PATCH /account/profile`: an optional display name, 1-60 printable
    characters;
  - `GET /account/sessions` and `DELETE /account/sessions/{id}`: the user's
    working sessions, with the IP and User-Agent recorded when they
    started (shown only to the user), and ending one (another user's is
    the same 404 as a missing one);
  - `POST /account/delete`: needs the password (with the login rate
    limits), and is refused while the user is the only owner of a
    workspace; memberships and sessions go with the user;
  - `POST /workspaces`: a new workspace, with the user as owner, at most 20
    owned;
  - `DELETE /workspaces/{id}/membership`: leaving, refused for the only
    owner.
- **Audit.** New actions `user.profile_updated` and `user.session_revoked`
  (best effort, like sign-ins), `user.deleted` (strict, in every workspace,
  inside the transaction) and `membership.removed` (strict). A new
  workspace records `tenant.created` strictly. Events hold IDs only, never
  the display name.
- **Animated charts.** On the overview, columns grow from the baseline,
  bars slide out, sparklines draw and stat numbers count up. Each plays
  once; under `prefers-reduced-motion` the final frame shows at once.

## Later changes

- The account moved from its own page (/account) into a dialog opened
  from the navbar's account menu (the owner's request): tabs for profile,
  password, sessions, workspaces and deleting the account. /account no
  longer exists.

## Consequences

- One gateway migration (`users.display_name`, `sessions.ip`,
  `sessions.user_agent`) and new dashboard routes and tests.
- Not added: inviting people by email (no email), transferring ownership,
  or a server-side theme preference shared across browsers.
