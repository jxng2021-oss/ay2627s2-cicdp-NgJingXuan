# 0036: A separate log per user pool, owner unlock and reset at next sign in

- Status: Accepted
- Date: 2026-11-23

## Context

Testing the platform on the live server with the demo shop showed three
problems with user pools:

- every end user's sign in, failed sign in and sign out went into the
  workspace's audit log, so a busy app buried the workspace's own events
  (keys, secrets, files);
- a locked user showed as both "Active" and "Locked", and an owner could only
  wait 15 minutes for the lock to end;
- an owner's password reset produced a temporary password that the owner
  then had to hand over to the user.

## Decision

**A chain per pool.** The audit service gets a third kind of chain,
`pool:<poolId>`, next to the tenant and platform chains. Every
`pool_user.*` and `pool_role.*` action is recorded only there: the identity
service now sends the pool's ID with them, and the audit service refuses a
pool action without one (and a pool ID on any other action). Creating,
renaming and deleting a pool stay in the workspace's chain, because they are
changes to the workspace. Each pool chain is its own HMAC chain, so it is
tamper-evident on its own and `verify --all` checks it like the others.
Events already recorded in a workspace chain stay there: an audit log is
never rewritten.

Reading a pool's chain goes through the gateway only
(`GET /pools/{poolId}/events` on the audit service, with the tenant from the
verified membership) and filters on the tenant too, so a pool ID from another
workspace reads nothing; the dashboard checks the pool exists first and
answers 404 otherwise. The dashboard shows it as **User pools → User logs**,
next to **User pools → Users**.

**One status and owner unlock.** A pool user shows one status: Disabled,
else Locked, else Active. Owners can unlock a locked user
(`pool_user.unlocked`, audited strictly).

**Reset at next sign in.** An owner's reset no longer creates a password.
It marks the user `passwordResetRequired` and ends their sessions. The user
signs in with their current password; the sign-in answer succeeds and says
`passwordResetRequired: true`, and the app sends them to choose a new
password (the existing change-password route, which clears the flag). This is
an added response field, so v1 stays compatible.

## Consequences

- The workspace audit log shows workspace activity only; each pool's activity
  is reviewed pool by pool.
- `GET /v1/audit-events` no longer returns new pool user events. Apps that
  want them read the pool's log in the dashboard; a public route for it can be
  added to v1 later without breaking anything.
- A reset no longer helps a user who forgot their password: they keep their
  password until they change it. Email-based recovery is out of scope (no
  email in this phase).
