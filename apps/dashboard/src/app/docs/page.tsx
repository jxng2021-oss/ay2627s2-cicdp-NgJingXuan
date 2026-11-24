import type { Metadata } from "next";
import Link from "next/link";
import { Code, Note } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Quickstart" };

export default function QuickstartPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Quickstart</h1>
        <p className="title-2">
          Connect an Express app to secure-cloud in five minutes. You need
          Node.js 20.19 or newer and a workspace in the dashboard.
        </p>
      </header>

      <p>
        The SDK gives your server six things: calling outside APIs (like a
        payment provider) without ever holding their keys, storing files
        encrypted, signing your own users in, checking their roles and
        permissions, feature flags, and trusted payment webhooks. It runs on
        your <strong>server only</strong>, because it uses your app&apos;s API
        key.
      </p>

      <h2 className="heading-5">1. Create an API key</h2>
      <p>
        In the <Link href="/workspaces">dashboard</Link>, open your workspace,
        then <strong>API keys</strong>, then <strong>Create API key</strong>.
        Name it after your app, for example <code>my-shop-server</code>. Copy
        the key now: it is shown only once.
      </p>

      <h2 className="heading-5">2. Install the SDK</h2>
      <p>
        Start a new project (or use your own), then install Express and the SDK.
        The SDK is a file you get from the platform&apos;s repository with{" "}
        <code>pnpm sdk:pack</code> (it lands in <code>.local/</code>); copy it
        into your project first.
      </p>
      <Code>{`
mkdir my-app && cd my-app
npm init -y
npm install express ./secure-cloud-sdk-0.1.0.tgz
`}</Code>

      <h2 className="heading-5">3. Put your key in a .env file</h2>
      <p>
        The SDK reads two settings from the environment, so the key never sits
        in your code.
      </p>
      <Code title=".env">{`
SECURE_CLOUD_API_KEY=paste_your_key_here
SECURE_CLOUD_URL=http://localhost:8080
`}</Code>
      <Note tone="warning">
        Add <code>.env</code> to your <code>.gitignore</code>. Anyone with the
        key can use your workspace. If it leaks, revoke it in the dashboard and
        create a new one.
      </Note>

      <h2 className="heading-5">4. Write server.js</h2>
      <Code title="server.js">{`
const express = require("express");
const { SecureCloud, errorHandler } = require("@secure-cloud/sdk");

const app = express();
app.use(express.json());

// Reads SECURE_CLOUD_API_KEY and SECURE_CLOUD_URL from the environment.
const cloud = new SecureCloud();

// List the files stored in your workspace.
app.get("/files", async (req, res) => {
  const files = await cloud.files.list();
  res.json(files);
});

// Turns SDK errors into clean JSON answers. Keep it after your routes.
app.use(errorHandler());

app.listen(3000, () => {
  console.log("Listening on http://localhost:3000");
});
`}</Code>
      <Note>
        This uses Express 5 (what <code>npm install express</code> gives you
        today), which passes errors from <code>async</code> routes to{" "}
        <code>errorHandler()</code> for you. On Express 4, wrap each route in{" "}
        <code>try</code> and <code>catch</code> and call{" "}
        <code>next(error)</code>.
      </Note>

      <h2 className="heading-5">5. Run it</h2>
      <Code>{`
node --env-file=.env server.js
curl http://localhost:3000/files
`}</Code>
      <p>
        You should see <code>[]</code>, or your files if you uploaded some in
        the dashboard. That&apos;s it: your app is talking to secure-cloud.
      </p>

      <h2 className="heading-5">Using import instead of require</h2>
      <p>
        If your project uses ES modules (
        <code>&quot;type&quot;: &quot;module&quot;</code> in{" "}
        <code>package.json</code>), import the same names:
      </p>
      <Code title="server.js">{`
import express from "express";
import { SecureCloud, errorHandler } from "@secure-cloud/sdk";
`}</Code>
      <p>
        TypeScript works out of the box: the SDK ships its own types, so your
        editor completes every function and shows what it returns.
      </p>

      <NextPage current="/docs" />
    </>
  );
}
