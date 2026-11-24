import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Feature flags" };

export default function FlagsDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Feature flags</h1>
        <p className="title-2">
          Ship a feature switched off, then choose who sees it from the
          dashboard, without redeploying.
        </p>
      </header>

      <h2 className="heading-5">How it works</h2>
      <ol>
        <li>
          Create a flag in the dashboard (Feature flags), like{" "}
          <code>new-checkout</code>. It starts off everywhere.
        </li>
        <li>
          Your server asks the SDK whether the flag is on for the signed in
          user, and shows the feature only if it is.
        </li>
        <li>
          In the dashboard, turn it on and pick who sees it: chosen users from
          your user pools, and what everyone else gets. The next request follows
          the change.
        </li>
      </ol>

      <h2 className="heading-5">Check a flag</h2>
      <Code title="server.js">{`
const express = require("express");
const { SecureCloud } = require("@secure-cloud/sdk");

const cloud = new SecureCloud();
const users = cloud.userPool(process.env.SECURE_CLOUD_POOL_ID);
const flags = cloud.flags("production");
const app = express();

app.get("/checkout", users.requireUser(), async (req, res) => {
  const user = { id: req.user.id, email: req.user.email };
  if (await flags.isOn("new-checkout", user)) {
    return res.send("The new checkout");
  }
  res.send("The old checkout");
});

app.listen(3000);
`}</Code>
      <p>
        Pass the user&apos;s ID from the user pool as <code>id</code>, and their{" "}
        <code>email</code>: the dashboard can choose users by either.
      </p>
      <Params
        rows={[
          [
            "cloud.flags(environment)",
            "Flags",
            '"development", "staging" or "production". Leave it out to use SECURE_CLOUD_ENVIRONMENT, or production.',
          ],
          [
            "flags.isOn(key, user)",
            "Promise<boolean>",
            "true only if the flag gives this user true. A flag that doesn't exist is false.",
          ],
          [
            "flags.value(key, user, fallback)",
            "Promise<boolean | string>",
            "The flag's value for this user (for text flags), or fallback if there is no such flag.",
          ],
          [
            "flags.evaluate(user, keys?)",
            "Promise<object>",
            "Every flag (or only keys) for this user, each with its value and the reason: off, rule, rollout or default.",
          ],
          [
            "user",
            "{ id, email?, attributes? }",
            "id is required; email and attributes are what the dashboard's choices can match.",
          ],
        ]}
      />

      <h2 className="heading-5">Text flags</h2>
      <Code title="variant.js">{`
const variant = await flags.value("checkout-button", user, "control");
// "control", or another value you chose in the dashboard
`}</Code>

      <Note>
        Ask on each request rather than once at start up: that is how a change
        in the dashboard reaches your users without a redeploy.
      </Note>
      <Note tone="warning">
        Check flags on your server. The API key must never reach a browser.
      </Note>

      <h2 className="heading-5">When something goes wrong</h2>
      <Params
        rows={[
          [
            "INVALID_ENVIRONMENT",
            "0",
            "flags() got something other than development, staging or production.",
          ],
          ["MISSING_USER_ID", "0", "The user has no id. Nothing was sent."],
          [
            "INVALID_API_KEY",
            "401",
            "The API key is wrong or revoked, like everywhere else.",
          ],
        ]}
      />
      <p>
        With <code>errorHandler()</code> in your app these become a clean answer
        on their own. To keep a page working if flags can&apos;t be read, catch
        the error and treat the feature as off.
      </p>

      <NextPage current="/docs/flags" />
    </>
  );
}
