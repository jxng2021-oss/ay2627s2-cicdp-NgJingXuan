import type { IconName } from "@/components/icons";

export type FeatureId =
  "keys" | "secrets" | "connections" | "files" | "audit" | "pools" | "flags";

export interface Feature {
  id: FeatureId;
  name: string;
  icon: IconName;
  tagline: string;
  description: string;
}

export const FEATURES: readonly Feature[] = [
  {
    id: "secrets",
    name: "Sealed secrets",
    icon: "secrets",
    tagline: "Keys go in. Nobody, not even you, reads them back.",
    description:
      "Every value is encrypted with 256 bit AES under your workspace's own key, inside a vault that three of five key holders must unseal. Forgot one? Rotate it.",
  },
  {
    id: "connections",
    name: "Connections and policies",
    icon: "connections",
    tagline: "Your apps call payment or SMS APIs without ever holding the key.",
    description:
      "The gateway adds the secret to each outgoing request and never returns it. Policies cap the routes, the rate and the amount, checked before the key is touched.",
  },
  {
    id: "files",
    name: "Encrypted files",
    icon: "files",
    tagline: "Every file gets its own key. Delete it, and the key is shredded.",
    description:
      "Files are encrypted in 64 KiB authenticated chunks before they reach the disk. Deleting a workspace destroys its key, so even old copies become noise.",
  },
  {
    id: "audit",
    name: "Audit log you can check",
    icon: "audit",
    tagline: "Every sensitive action, chained so edits can't hide.",
    description:
      "Each event is linked to the one before it with an HMAC, so a changed or deleted row breaks the chain. Find any request by its ID.",
  },
  {
    id: "pools",
    name: "User pools",
    icon: "users",
    tagline: "Sign your app's own users up and in, with tokens you can verify.",
    description:
      "Passwords hashed with Argon2id, signed ES256 tokens your app checks with public keys, refresh tokens that work once, and each pool's signing key sealed in the vault.",
  },
  {
    id: "flags",
    name: "Feature flags",
    icon: "flag",
    tagline: "Turn features on for some users, in one environment, instantly.",
    description:
      "Flags for each environment, with targeting rules and stable percentage rollouts, evaluated for each user through the API. Every change is in the audit log.",
  },
  {
    id: "keys",
    name: "API keys and limits",
    icon: "keys",
    tagline: "One revocable key per app, with rate limits at the gateway.",
    description:
      "256 bit keys shown once, stored only as a hash. Revoke one at any time; rate limits for each key keep a leaked key from doing much.",
  },
];
