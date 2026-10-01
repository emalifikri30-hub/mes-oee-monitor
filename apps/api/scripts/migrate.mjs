// Migration runner for the GOLD tier — `vp run api#db:migrate`
// (or `pnpm --filter api db:migrate`).
//
// Gold is the only database this service owns. The Silver tier (TimescaleDB) is
// deliberately NOT managed here: its hypertables, continuous aggregates, and
// compression/retention policies are owned by the virtual-factory repo
// (docs/timescale-schema.sql) and written by Telegraf. This service connects to
// Silver read-only.
//
// Applies every `src/shared/database/migration/*.sql` file, in filename order,
// that is not already recorded in the `schema_migrations` table. Each file runs
// inside its own transaction together with the bookkeeping INSERT, so a failing
// migration leaves no partial state and no version row behind.
//
// This is plain `.mjs` rather than TypeScript so it runs on any Node the repo
// supports (>=22.12) without depending on type stripping, and so it needs no
// build step — the same reason `instrumentation.mjs` is plain JS.
import "dotenv/config";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const MIGRATION_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/shared/database/migration",
);

const url = process.env.GOLD_DATABASE_URL;
if (!url) {
  console.error("GOLD_DATABASE_URL is not set");
  process.exit(1);
}

// No camel transform here: this script speaks raw SQL only, and the
// `schema_migrations` columns are already snake_case.
const sql = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { application_name: "api-gold-migrate" },
});

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await sql`SELECT version FROM schema_migrations`).map((row) => row.version),
  );

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`No pending migrations (${applied.size} already applied).`);
    return;
  }

  for (const file of pending) {
    const ddl = await readFile(path.join(MIGRATION_DIR, file), "utf8");
    // `sql.unsafe` is required because a migration file is a multi-statement
    // script, not a parameterised query. The input is a checked-in file, never
    // user data.
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations ${tx({ version: file })}`;
    });
    console.log(`applied ${file}`);
  }

  console.log(`Done — ${pending.length} migration(s) applied.`);
}

try {
  await main();
} catch (err) {
  console.error("migration failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
