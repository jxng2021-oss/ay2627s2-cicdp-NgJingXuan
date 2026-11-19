import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDatabase, MIGRATIONS_FOLDER } from "./db/client.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const { db, close } = connectDatabase(databaseUrl);
try {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Database migrations are up to date");
} finally {
  await close();
}
