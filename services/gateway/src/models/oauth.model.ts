import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { oauthIdentities } from "../db/schema.js";

export type OAuthProviderId = (typeof oauthIdentities.$inferSelect)["provider"];

export function findOAuthUserId(
  db: Database,
  provider: OAuthProviderId,
  subject: string,
): Promise<string | undefined> {
  return db
    .select({ userId: oauthIdentities.userId })
    .from(oauthIdentities)
    .where(
      and(
        eq(oauthIdentities.provider, provider),
        eq(oauthIdentities.subject, subject),
      ),
    )
    .then(([row]) => row?.userId);
}

export async function insertOAuthIdentity(
  db: Database,
  values: { provider: OAuthProviderId; subject: string; userId: string },
): Promise<void> {
  await db.insert(oauthIdentities).values(values).onConflictDoNothing();
}
