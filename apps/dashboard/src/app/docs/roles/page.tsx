import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Roles and permissions" };

export default function RolesDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Roles and permissions</h1>
        <p className="title-2">
          Decide what each of your users may do. A role is a name, like{" "}
          <code>support</code>, with the permissions it gives, like{" "}
          <code>orders:refund</code>. You choose both.
        </p>
      </header>

      <h2 className="heading-5">How it works</h2>
      <ol>
        <li>
          You create roles in a user pool, each with a list of permissions.
        </li>
        <li>You give roles to users (a user can have several).</li>
        <li>
          When a user signs in, their roles and every permission those roles
          give go into their access token.
        </li>
        <li>
          Your routes check the token with <code>requirePermission()</code> or{" "}
          <code>requireRole()</code>. No call to the platform: the token says it
          all.
        </li>
      </ol>
      <p>
        You can manage roles in the dashboard (User pools, then your pool) or
        from your code with the SDK, as below.
      </p>

      <h2 className="heading-5">Create roles</h2>
      <Code title="setup-roles.js">{`
const { SecureCloud } = require("@secure-cloud/sdk");

const cloud = new SecureCloud();
const users = cloud.userPool(process.env.SECURE_CLOUD_POOL_ID);

async function main() {
  await users.createRole({
    name: "support",
    description: "Answers customers",
    permissions: ["orders:read", "orders:refund"],
  });
  await users.createRole({
    name: "admin",
    description: "Runs the shop",
    permissions: ["*"],
  });
}

main();
`}</Code>
      <p>
        Run it once: <code>node --env-file=.env setup-roles.js</code>. A name
        that is taken throws <code>CONFLICT</code>.
      </p>
      <Params
        rows={[
          [
            "name",
            "string",
            "Lowercase letters, digits, dots, colons, dashes or underscores. It can't be changed later.",
          ],
          [
            "description",
            "string (optional)",
            "Who gets the role, for you and your team.",
          ],
          [
            "permissions",
            "string[]",
            "Your own words, like orders:refund. orders:* gives everything under orders; * gives everything.",
          ],
        ]}
      />

      <h2 className="heading-5">Give roles to users</h2>
      <Code title="server.js">{`
// For example when an admin promotes someone in your app.
await users.addRole(userId, "support");

// And to take it back:
await users.removeRole(userId, "support");
`}</Code>
      <p>
        Both are safe to repeat. A user can have up to 20 roles, and a pool up
        to 50.
      </p>

      <h2 className="heading-5">Protect routes</h2>
      <Code title="server.js">{`
const cookie = { cookie: "access_token" };

// Only users whose roles give this permission.
app.post("/orders/:id/refund", users.requirePermission("orders:refund", cookie), async (req, res) => {
  await refundOrder(req.params.id, req.user.id);
  res.json({ refunded: true });
});

// Only users with this role.
app.get("/admin", users.requireRole("admin", cookie), (req, res) => {
  res.send("Welcome, admin");
});
`}</Code>
      <p>
        Signed out users get a <code>401</code>, and signed in users without the
        permission a <code>403</code>. Both are JSON answers, and your route
        never runs.
      </p>

      <h2 className="heading-5">Check in your own code</h2>
      <p>
        Inside a route, <code>req.user</code> has the user&apos;s{" "}
        <code>roles</code> and <code>permissions</code>.{" "}
        <code>hasPermission()</code> understands the wildcards for you.
      </p>
      <Code title="server.js">{`
const { hasPermission } = require("@secure-cloud/sdk");

app.get("/orders/:id", users.requireUser(cookie), async (req, res) => {
  const order = await findOrder(req.params.id);
  const mine = order.customerId === req.user.id;
  if (!mine && !hasPermission(req.user, "orders:read")) {
    return res.status(404).json({ message: "No such order" });
  }
  res.json(order);
});
`}</Code>
      <Note>
        A change to a user&apos;s roles reaches their next access token. Until
        then their current token keeps its old roles, for at most the
        pool&apos;s access token lifetime (15 minutes by default). Make it
        shorter in the dashboard if changes must apply sooner.
      </Note>

      <h2 className="heading-5">Manage roles from code</h2>
      <Params
        rows={[
          [
            "listRoles()",
            "Role[]",
            "Every role in the pool, with how many users have it.",
          ],
          [
            "createRole({ name, description, permissions })",
            "Role",
            "Creates a role.",
          ],
          ["getRole(name)", "Role", "One role."],
          [
            "updateRole(name, { description, permissions })",
            "Role",
            "Changes a role; its users get the new permissions in their next token.",
          ],
          [
            "deleteRole(name)",
            "nothing",
            "Deletes a role and takes it from its users.",
          ],
          ["addRole(userId, role)", "PoolUser", "Gives a user a role."],
          ["removeRole(userId, role)", "PoolUser", "Takes a role from a user."],
          [
            "requireRole(role, { cookie })",
            "middleware",
            "Lets only users with the role through.",
          ],
          [
            "requirePermission(permission, { cookie })",
            "middleware",
            "Lets only users with the permission through.",
          ],
          [
            "hasPermission(user, permission)",
            "boolean",
            "Checks a permission, wildcards included.",
          ],
        ]}
      />
      <Note tone="warning">
        Managing roles uses your app&apos;s API key, so only your server can do
        it. Never let a user give themselves a role: check that they may (for
        example with <code>requireRole(&quot;admin&quot;)</code>) first.
      </Note>

      <NextPage current="/docs/roles" />
    </>
  );
}
