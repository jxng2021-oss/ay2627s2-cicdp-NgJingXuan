import type { Metadata } from "next";
import { Code, Note } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Express helpers" };

export default function ExpressDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Express helpers</h1>
        <p className="title-2">
          Three small helpers that save you writing the same code in every app.
          They work with Express 4 and 5.
        </p>
      </header>

      <h2 className="heading-5">errorHandler(): clean error answers</h2>
      <p>
        Add it once, after your routes. When an SDK call fails inside a route,
        your user gets a short JSON answer instead of a crash.
      </p>
      <Code title="server.js">{`
const { errorHandler } = require("@secure-cloud/sdk");

// ...your routes...

app.use(errorHandler());
`}</Code>
      <p>What your users see:</p>
      <ul>
        <li>
          <strong>Their own mistakes</strong> keep their status and message, for
          example <code>404</code> for a missing file, <code>401</code> for a
          wrong password or <code>409</code> for a taken email.
        </li>
        <li>
          <strong>Problems with your setup</strong> (a wrong or revoked API key,
          the gateway unreachable) become a plain <code>500</code>. The details
          are written to your server&apos;s log, never sent to the browser.
        </li>
        <li>
          <strong>Other errors</strong> (not from the SDK) go on to
          Express&apos;s own error handling, as usual.
        </li>
      </ul>
      <Code title="What the browser gets">{`
{ "error": { "code": "NOT_FOUND", "message": "File not found" } }
`}</Code>

      <h2 className="heading-5">requireUser(): signed in users only</h2>
      <Code title="server.js">{`
const users = cloud.userPool(process.env.SECURE_CLOUD_POOL_ID);

app.get("/orders", users.requireUser({ cookie: "access_token" }), async (req, res) => {
  res.json(await ordersFor(req.user.id));
});
`}</Code>
      <p>
        It reads the token from the cookie you name (or the{" "}
        <code>Authorization</code> header), checks it, and puts the user on{" "}
        <code>req.user</code>: <code>id</code>, <code>email</code>,{" "}
        <code>attributes</code> and <code>expiresAt</code>. Without a valid
        token the answer is a 401 and your route never runs.
      </p>

      <h2 className="heading-5">files.send(): a download in one line</h2>
      <Code title="server.js">{`
app.get("/files/:id", users.requireUser({ cookie: "access_token" }), async (req, res) => {
  await cloud.files.send(res, req.params.id);
});
`}</Code>
      <p>
        It streams the file with its original name. Files are always sent as
        downloads, never shown inside the page, so a stored file can&apos;t run
        as part of your site.
      </p>

      <h2 className="heading-5">A complete example</h2>
      <Code title="server.js">{`
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { SecureCloud, errorHandler } = require("@secure-cloud/sdk");

const app = express();
app.use(express.json());
app.use(cookieParser());

const cloud = new SecureCloud();
const users = cloud.userPool(process.env.SECURE_CLOUD_POOL_ID);
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const signedIn = users.requireUser({ cookie: "access_token" });

app.post("/sign-in", async (req, res) => {
  const session = await users.signIn(req.body);
  res.cookie("access_token", session.accessToken, { httpOnly: true, sameSite: "lax" });
  res.cookie("refresh_token", session.refreshToken, { httpOnly: true, sameSite: "lax" });
  res.json({ email: session.user.email });
});

app.post("/photos", signedIn, upload.single("photo"), async (req, res) => {
  res.status(201).json(await cloud.files.upload(req.file));
});

app.post("/checkout", signedIn, async (req, res) => {
  const charge = await cloud.connections.call("payments", "POST /charges", {
    amount: req.body.amount,
    currency: "sgd",
    description: \`Order for \${req.user.email}\`,
  });
  res.status(charge.ok ? 201 : 402).json(charge.data);
});

app.use(errorHandler());
app.listen(3000);
`}</Code>
      <Note>
        In a real shop, work out the amount on your server from your own prices.
        Never trust an amount sent by the browser.
      </Note>

      <NextPage current="/docs/express" />
    </>
  );
}
