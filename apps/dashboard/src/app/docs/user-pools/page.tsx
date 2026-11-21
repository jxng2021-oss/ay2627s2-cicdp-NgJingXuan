import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "User sign in" };

export default function UserPoolsDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">User sign in</h1>
        <p className="title-2">
          Sign your app&apos;s users up and in with a user pool. The platform
          keeps their passwords; your app gets tokens it can check itself.
        </p>
      </header>

      <h2 className="heading-5">Create a user pool</h2>
      <p>
        In the dashboard, open <strong>User pools</strong>, then{" "}
        <strong>Create user pool</strong>. Open the pool and copy its{" "}
        <strong>Pool ID</strong> into your <code>.env</code> file:
      </p>
      <Code title=".env">{`
SECURE_CLOUD_POOL_ID=paste_the_pool_id_here
`}</Code>
      <Code title="server.js">{`
const users = cloud.userPool(process.env.SECURE_CLOUD_POOL_ID);
`}</Code>

      <h2 className="heading-5">Sign up</h2>
      <Code title="server.js">{`
app.post("/sign-up", async (req, res) => {
  const { email, password } = req.body;
  const user = await users.signUp({ email, password });
  res.status(201).json({ id: user.id, email: user.email });
});
`}</Code>
      <p>
        A taken email throws <code>CONFLICT</code> (409), and a short or common
        password <code>BAD_REQUEST</code> (400). <code>errorHandler()</code>{" "}
        sends both to the browser as JSON with a clear message.
      </p>

      <h2 className="heading-5">Sign in</h2>
      <p>
        Signing in gives you two tokens. Keep them in cookies that scripts on
        the page can&apos;t read (<code>httpOnly</code>).
      </p>
      <Code title="server.js">{`
app.post("/sign-in", async (req, res) => {
  const { email, password } = req.body;
  const session = await users.signIn({ email, password });

  const cookie = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" };
  res.cookie("access_token", session.accessToken, { ...cookie, maxAge: session.expiresIn * 1000 });
  res.cookie("refresh_token", session.refreshToken, { ...cookie, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ email: session.user.email });
});
`}</Code>
      <Params
        rows={[
          [
            "accessToken",
            "string",
            "Proves who the user is, for a few minutes.",
          ],
          [
            "expiresIn",
            "number",
            "Seconds until the access token stops working.",
          ],
          [
            "refreshToken",
            "string",
            "Gets new tokens with refresh(). It works once.",
          ],
          ["user", "object", "The user: id, email, status, attributes."],
        ]}
      />
      <Note>
        A wrong email and a wrong password get the same{" "}
        <code>UNAUTHORIZED</code> error, so nobody can find out which emails
        have accounts. After 5 wrong passwords in a row the user is locked for
        15 minutes.
      </Note>

      <h2 className="heading-5">Protect a route</h2>
      <p>
        <code>requireUser()</code> lets signed in users through and puts them on{" "}
        <code>req.user</code>. Everyone else gets a 401.
      </p>
      <Code title="server.js">{`
app.get("/me", users.requireUser({ cookie: "access_token" }), (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});
`}</Code>
      <p>
        Without the <code>cookie</code> option it reads an{" "}
        <code>Authorization: Bearer ...</code> header instead, which suits
        mobile apps. The token is checked on your server with the pool&apos;s
        public keys: no call to the platform for each request.
      </p>

      <h2 className="heading-5">Keep users signed in</h2>
      <p>
        When the access token expires, swap the refresh token for new ones.
        Always save the new refresh token: an old one used again ends the whole
        session (someone may have copied it).
      </p>
      <Code title="server.js">{`
app.post("/refresh", async (req, res) => {
  const session = await users.refresh(req.cookies.refresh_token);
  // ...set both cookies again, as in /sign-in
  res.json({ ok: true });
});
`}</Code>
      <Note>
        <code>req.cookies</code> needs <code>cookie-parser</code>:{" "}
        <code>npm install cookie-parser</code>, then{" "}
        <code>app.use(require(&quot;cookie-parser&quot;)())</code>.
      </Note>

      <h2 className="heading-5">Sign out</h2>
      <Code title="server.js">{`
app.post("/sign-out", async (req, res) => {
  await users.signOut(req.cookies.refresh_token);
  res.clearCookie("access_token").clearCookie("refresh_token");
  res.json({ ok: true });
});
`}</Code>

      <h2 className="heading-5">Everything a pool can do</h2>
      <Params
        rows={[
          [
            "signUp({ email, password, attributes })",
            "PoolUser",
            'Creates a user. attributes are your own fields, like { plan: "pro" }.',
          ],
          ["signIn({ email, password })", "Session", "Signs a user in."],
          [
            "refresh(refreshToken)",
            "Session",
            "New tokens; the old refresh token stops working.",
          ],
          ["signOut(refreshToken)", "nothing", "Ends the session."],
          [
            "verify(accessToken)",
            "user",
            "Checks a token on your server; throws INVALID_TOKEN if it can't be used.",
          ],
          [
            "requireUser({ cookie })",
            "middleware",
            "Protects Express routes, as above.",
          ],
          ["getUser(userId)", "PoolUser", "A user's details."],
          [
            "changePassword(userId, { currentPassword, newPassword })",
            "nothing",
            "Changes a password and ends the user's other sessions.",
          ],
          [
            "listRoles(), createRole(), addRole() and more",
            "",
            "Roles and permissions: see the next page.",
          ],
        ]}
      />

      <NextPage current="/docs/user-pools" />
    </>
  );
}
