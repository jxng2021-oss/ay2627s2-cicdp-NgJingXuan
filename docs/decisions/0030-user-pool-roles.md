# 0030: Roles and permissions in user pools

- Status: Accepted
- Date: 2026-11-16

## Context

Apps using user pools ([0025](0025-user-pools.md)) need to decide what
each of their users may do: support staff refund orders, admins run the
shop. The owner asked for roles that a developer creates, changes, removes
and gives to their app's users, in the SDK as well. Their choices
(2026-11-16):

- **roles with permissions**: a role is a name holding permissions the app
  names itself (`orders:refund`);
- **in the access token**: apps check them locally, with no extra call;
  a change applies from the user's next token;
- **dashboard and SDK**: owners manage roles in the dashboard, apps through
  `/v1` and the SDK with their API key.

CLAUDE.md rules out "access policies beyond connection policies" for now.
That is about who may do what on the platform itself (its dashboard, API
keys and workspaces). These roles are data the platform keeps for an app,
about the app's own users, like their attributes; they change nothing the
platform allows. They are recorded here as that distinction.

## Decision

- **Identity service:** `pool_roles` (pool, unique name, description,
  permissions as a JSON list) and `pool_user_roles` (user, role), both
  deleted with their pool, user or role. Names: lower case letters, digits,
  `.`, `:`, `_` and `-`. Permissions: the same characters with upper case
  allowed, and a trailing `:*` or `.*`, or `*` alone, as wildcards. At most
  50 roles per pool, 100 permissions per role and 20 roles per user, so
  tokens stay small.
- **Routes** (internal, then `/v1` and the dashboard): list, create, read,
  change and delete roles, by name; give and take a role
  (`PUT` / `DELETE .../users/{userId}/roles/{role}`), safe to repeat. Users
  carry a `roles` list. The gateway forwards only validated fields, with
  the tenant from the verified key or membership; members view roles in
  the dashboard, owners change them.
- **Tokens:** access tokens gain `roles` (names) and `permissions` (every
  permission of those roles, sorted, once each). Nothing is cached: each
  sign in and refresh reads the current roles. Old tokens without the
  claims count as no roles.
- **Audit:** `pool_role.created`, `pool_role.updated`, `pool_role.deleted`,
  `pool_user.role_added` and `pool_user.role_removed`, recorded strictly
  (refused if they can't be); repeating a give or take that changes
  nothing records nothing.
- **SDK:** `listRoles`, `createRole`, `getRole`, `updateRole`,
  `deleteRole`, `addRole`, `removeRole`; `verify()` returns `roles` and
  `permissions`; `hasPermission(user, permission)` understands the
  wildcards; `requireRole()` and `requirePermission()` answer 401 to
  signed out users and 403 to the rest. A docs page, "Roles and
  permissions".
- **Dashboard:** a Roles section on the pool's page (create, edit, delete
  after confirming) and a Roles card on each user's page (give from a
  list, take after confirming).

## Consequences

- A change to roles reaches a user within the pool's access token lifetime
  (15 minutes by default); the docs say so and suggest a shorter lifetime
  if that matters.
- Public API 1.10.0: new routes and fields only.
- Not built: role inheritance, permissions on the platform itself,
  per-resource rules (the app decides those), renaming a role.
