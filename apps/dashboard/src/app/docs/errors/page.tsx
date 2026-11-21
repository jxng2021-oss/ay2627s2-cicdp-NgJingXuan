import type { Metadata } from "next";
import { Code, Params } from "@/components/docs/code";

export const metadata: Metadata = { title: "Errors" };

export default function ErrorsDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Errors</h1>
        <p className="title-2">
          Every failure is a <code>SecureCloudError</code> with a code you can
          check and a message that says what to do next.
        </p>
      </header>

      <Code title="server.js">{`
const { isSecureCloudError } = require("@secure-cloud/sdk");

try {
  await cloud.files.get(fileId);
} catch (error) {
  if (isSecureCloudError(error) && error.code === "NOT_FOUND") {
    return res.status(404).send("No such file");
  }
  throw error; // anything else: let errorHandler() deal with it
}
`}</Code>
      <Params
        rows={[
          [
            "code",
            "string",
            "A stable name, like NOT_FOUND. Check this, not the message.",
          ],
          [
            "status",
            "number",
            "The HTTP status, or 0 when the platform couldn't be reached.",
          ],
          ["message", "string", "What went wrong, in plain words."],
          [
            "requestId",
            "string (optional)",
            "Search for it in your workspace's audit log to see what happened.",
          ],
        ]}
      />

      <h2 className="heading-5">Setup problems</h2>
      <Params
        rows={[
          [
            "MISSING_API_KEY",
            "0",
            "No key: set SECURE_CLOUD_API_KEY, or pass { apiKey }.",
          ],
          [
            "INVALID_URL",
            "0",
            "SECURE_CLOUD_URL isn't an address like http://localhost:8080.",
          ],
          [
            "UNREACHABLE",
            "0",
            "The gateway didn't answer at that address. Is it running?",
          ],
          [
            "TIMEOUT",
            "0",
            "No answer within 30 seconds (change it with { timeoutMs }).",
          ],
          [
            "INVALID_API_KEY",
            "401",
            "The API key is wrong or revoked. Create a new one in the dashboard.",
          ],
          [
            "INVALID_POOL_ID",
            "0",
            "userPool() got something that isn't a pool ID.",
          ],
        ]}
      />

      <h2 className="heading-5">Common answers</h2>
      <Params
        rows={[
          [
            "BAD_REQUEST",
            "400",
            "Something you sent isn't valid; the message says what.",
          ],
          ["UNAUTHORIZED", "401", "From signIn(): a wrong email or password."],
          [
            "INVALID_TOKEN",
            "401",
            "From verify(): the token is expired, forged or for another pool.",
          ],
          [
            "FORBIDDEN",
            "403",
            "Your workspace is suspended, or a limit refused the call. From requireRole() or requirePermission(): the user lacks the role or permission.",
          ],
          [
            "NOT_FOUND",
            "404",
            "No such file, connection or user in your workspace.",
          ],
          ["CONFLICT", "409", "Already exists, like a taken email."],
          ["PAYLOAD_TOO_LARGE", "413", "The file is too big."],
          [
            "RATE_LIMITED",
            "429",
            "Too many requests; slow down and try again.",
          ],
          [
            "SECRETS_SEALED",
            "503",
            "The vault is sealed until it is unsealed. Try again later.",
          ],
          [
            "SERVICE_UNAVAILABLE",
            "503",
            "A part of the platform is down for a moment.",
          ],
        ]}
      />
    </>
  );
}
