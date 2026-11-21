import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Calling outside APIs" };

export default function ConnectionsDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Calling outside APIs</h1>
        <p className="title-2">
          Call a payment, SMS or email API without your app ever holding its
          key. The platform adds the key to each request on the way out.
        </p>
      </header>

      <h2 className="heading-5">Set it up once in the dashboard</h2>
      <ol>
        <li>
          <strong>Secrets</strong>, then <strong>Create secret</strong>: save
          the provider&apos;s key, for example as <code>payment-key</code>.
          Nobody can read it back after this, not even you.
        </li>
        <li>
          <strong>Connections</strong>, then <strong>Create connection</strong>:
          name it (for example <code>payments</code>), give the provider&apos;s
          base URL, and choose the secret and the header it goes in (usually{" "}
          <code>Authorization</code> with <code>Bearer </code> before it).
        </li>
        <li>
          Optional: add limits to the connection, like only{" "}
          <code>POST /charges</code>, at most 100 calls a minute, or at most
          5,000 in amounts a day. They are checked before the key is used.
        </li>
      </ol>

      <h2 className="heading-5">Make a call</h2>
      <Code title="server.js">{`
app.post("/checkout", async (req, res) => {
  const charge = await cloud.connections.call("payments", "POST /charges", {
    amount: 1849,
    currency: "sgd",
    description: "Order 1027",
  });

  if (!charge.ok) {
    // The provider said no, for example a declined card.
    return res.status(402).json({ message: "Payment failed", details: charge.data });
  }
  res.json({ paid: true, chargeId: charge.data.id });
});
`}</Code>
      <p>
        <code>call(connection, route, body)</code> sends <code>body</code> as
        JSON. Leave the method out for a GET:{" "}
        <code>
          cloud.connections.call(&quot;payments&quot;,
          &quot;/charges/ch_123&quot;)
        </code>
        .
      </p>
      <Params
        rows={[
          ["connection", "string", "The connection's name from the dashboard."],
          [
            "route",
            "string",
            'A method and a path, like "POST /charges", or just a path for a GET.',
          ],
          [
            "body",
            "object (optional)",
            "Sent as JSON. A string or Buffer is sent as it is.",
          ],
          [
            "options.query",
            "object (optional)",
            "Query string values, like { limit: 10 }.",
          ],
          [
            "options.headers",
            "object (optional)",
            "Extra headers for the provider. Never Authorization: the platform adds the key.",
          ],
        ]}
      />

      <h2 className="heading-5">What you get back</h2>
      <Params
        rows={[
          ["status", "number", "The provider's HTTP status, like 201."],
          ["ok", "boolean", "True when the status is 200 to 299."],
          [
            "data",
            "object or string",
            "The provider's answer: parsed JSON, or text when it isn't JSON.",
          ],
          ["headers", "object", "The provider's headers, in lower case."],
        ]}
      />
      <Note>
        The provider&apos;s own errors (a declined card, a bad request) come
        back as an answer with <code>ok: false</code>, so you decide what your
        users see. The SDK only throws when the platform itself refuses the
        call.
      </Note>

      <h2 className="heading-5">When the platform refuses</h2>
      <p>
        These throw a <code>SecureCloudError</code>. With{" "}
        <code>errorHandler()</code> in your app they become a clean JSON answer
        on their own.
      </p>
      <Params
        rows={[
          [
            "NOT_FOUND",
            "404",
            "No connection with that name in your workspace.",
          ],
          [
            "PROXY_POLICY_DENIED",
            "403",
            "A limit on the connection refused it: the route or the amount.",
          ],
          [
            "PROXY_RATE_LIMITED",
            "429",
            "Too many calls through this connection; try again shortly.",
          ],
          [
            "SECRETS_SEALED",
            "503",
            "The vault is sealed (for example after a restart) until it is unsealed.",
          ],
          ["UPSTREAM_UNAVAILABLE", "502", "The provider couldn't be reached."],
        ]}
      />
      <Code title="server.js">{`
const { isSecureCloudError } = require("@secure-cloud/sdk");

try {
  await cloud.connections.call("payments", "POST /charges", order);
} catch (error) {
  if (isSecureCloudError(error) && error.code === "PROXY_POLICY_DENIED") {
    return res.status(400).json({ message: "That order is over our limit." });
  }
  throw error;
}
`}</Code>

      <NextPage current="/docs/connections" />
    </>
  );
}
