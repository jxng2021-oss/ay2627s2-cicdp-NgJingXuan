# @secure-cloud/sdk

The secure-cloud SDK for Node.js (20.19 or newer). Server code only: it
uses your app's API key, which must never reach a browser.

- **Call outside APIs** without holding their keys:
  `cloud.connections.call("payments", "POST /charges", { amount: 1849 })`
- **Store files encrypted**: `cloud.files.upload(req.file)`,
  `cloud.files.send(res, id)`
- **Sign your users in**: `users.signIn({ email, password })`,
  `users.requireUser()`
- **Feature flags**: `cloud.flags("production").isOn("new-checkout", { id, email })`
- **Payment webhooks** signed by secure-cloud:
  `cloud.webhooks.verify(rawBody, req.headers["x-securecloud-signature"])`,
  or `cloud.webhooks.events({ after })` to pull them
- **Express helpers**: `errorHandler()`, `requireUser()`, `files.send()`

```js
const express = require("express");
const { SecureCloud, errorHandler } = require("@secure-cloud/sdk");

const app = express();
const cloud = new SecureCloud(); // reads SECURE_CLOUD_API_KEY and SECURE_CLOUD_URL

app.get("/files", async (req, res) => res.json(await cloud.files.list()));
app.use(errorHandler());
app.listen(3000);
```

The full guide is on the website at `/docs` (the dashboard's address, for
example http://localhost:3000/docs), with a five minute quickstart.

## Getting the package

It isn't on npm. From the platform's repository:

```sh
pnpm sdk:pack   # writes .local/secure-cloud-sdk-0.1.0.tgz
```

Copy the file into your project and `npm install ./secure-cloud-sdk-0.1.0.tgz`.

## Developing it

`src/` is plain TypeScript with no runtime dependencies (Node's own
`fetch`, `crypto` and streams). `pnpm --filter @secure-cloud/sdk test` runs
its unit tests against a fake gateway; `tests/e2e/sdk.test.ts` runs it
against the real stack. See docs/decisions/0029-sdk.md.
