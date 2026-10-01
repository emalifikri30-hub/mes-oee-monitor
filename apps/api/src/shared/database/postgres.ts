import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import postgres from "postgres";

type PostgresDBDeps = {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  debug?: boolean;
  // Surfaces in pg_stat_activity so a DBA can tell which service and which
  // medallion tier is holding a connection.
  applicationName?: string;
  // Opens the session with default_transaction_read_only, so a stray write
  // fails loudly. Defence in depth only — the authoritative protection is a
  // SELECT-only role on the database itself.
  readOnly?: boolean;
};

const MS_PER_SECOND = 1000;

// postgres.js expresses both timeouts in whole seconds, while AppConfig (and the
// `pg` Pool this replaced) express them in milliseconds. Round up so a sub-second
// setting never collapses to 0 — postgres.js reads 0 as "no timeout".
function toSeconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / MS_PER_SECOND));
}

function createPostgresDb({
  connectionString,
  max,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  debug,
  applicationName,
  readOnly,
}: PostgresDBDeps) {
  return postgres(connectionString, {
    max,
    idle_timeout: toSeconds(idleTimeoutMillis),
    connect_timeout: toSeconds(connectionTimeoutMillis),
    // Startup parameters, sent once per connection.
    connection: {
      ...(applicationName === undefined ? {} : { application_name: applicationName }),
      ...(readOnly === true ? { default_transaction_read_only: true } : {}),
    },
    // Columns are snake_case in the DB and camelCase in the app. `column.from`
    // maps rows on the way out; `column.to` maps the keys of the `sql(obj)`
    // INSERT/UPDATE helper on the way in. Domain types therefore need no
    // per-query `AS` aliases.
    transform: postgres.camel,
    debug,
  });
}

type PostgresDB = ReturnType<typeof createPostgresDb>;

// Tier aliases. These are structurally identical — the real separation is the
// Awilix registration name, since PROXY-mode injection resolves by key. They
// exist so the Cradle and each repository's deps say which tier they mean.
// The handle `sql.begin(...)` hands its callback. postgres.js names this
// `TransactionSql`; deriving it from `begin` instead does not work, because
// `begin` is overloaded and `Parameters<>` resolves to the last overload only.
type TransactionDB = postgres.TransactionSql;

type GoldDB = PostgresDB;
type SilverDB = PostgresDB;

// The `sql(obj)` INSERT/UPDATE helper builds its column list from
// `Object.keys(obj)`, so a key holding `undefined` is written as a literal NULL
// rather than skipped — on a NOT NULL column that is a runtime error. Partial
// patch objects go through here first so an absent field stays absent.
function definedColumns<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// postgres.js has no official OpenTelemetry instrumentation — the auto-patching
// @opentelemetry/instrumentation-pg only knows node-postgres — so repositories
// wrap each query in this helper to emit the client spans by hand.
const tracer = trace.getTracer("postgres");

async function traced<T>(operation: string, table: string, run: () => Promise<T>): Promise<T> {
  return await tracer.startActiveSpan(
    `${operation} ${table}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "postgresql",
        "db.operation": operation,
        "db.sql.table": table,
      },
    },
    async (span) => {
      try {
        return await run();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Operator mutations
// ---------------------------------------------------------------------------
//
// The `application_name` this service uses for its NAMED OPERATOR MUTATIONS, as
// opposed to the reads that make up everything else it does.
//
// `tierPool` in infra-module.ts already sets `<alias>-gold` per tier, and dbt is
// asked to set `dbt-gold` (docs/gold-write-contract.md §5), so the pipeline and
// this service are already distinguishable. What THIS name buys is separating
// this service's handful of writes from its own thousands of reads, which makes
//
//   SELECT * FROM oee.write_audit WHERE application_name = 'mes-oee-monitor-operator'
//
// a complete and precise list of every operator write ever made, with no
// row_key parsing and no join. TODOS.md §21 asks for it by name.
//
// ONE CONSTANT FOR ALL THREE MUTATIONS, which is now the whole set §21 named.
// Approving a shift report, reopening one, and editing a downtime all stamp this
// exact string; a fourth writer that stamped anything else would make the query
// above silently return part of the answer, with nothing to show it had.
//
// NOT AN IDENTITY. oee.write_audit records `current_user` (one shared pool role)
// and a SELF-REPORTED application_name; contract §6 makes the point that "an
// application_name is self-reported, a role is not". WHO approved a report is
// `closed_by` on the row, read from the JWT — never this.
const OPERATOR_APPLICATION_NAME = "mes-oee-monitor-operator";

// Stamps the operator application_name onto the CURRENT TRANSACTION only.
//
// TWO THINGS HERE ARE NOT STYLE CHOICES.
//
//   1. `set_config(..., is_local => true)` rather than `SET LOCAL`. `SET` is not
//      run through the extended query protocol, so it takes no bind parameters:
//      sql`SET LOCAL application_name = ${name}` does not work, and building the
//      string by hand is an injection site. set_config() is an ordinary function
//      call and parameterises normally.
//   2. `is_local => true` gives SET LOCAL semantics — the value reverts at
//      COMMIT or ROLLBACK. THAT REVERSION IS LOAD-BEARING, not tidiness:
//      postgres.js pools connections, so without it the next request to be
//      handed this connection would report itself as an operator mutation and
//      mislabel a pure read in the audit trail.
//
// Takes the transaction handle, never the pool, for the same reason: applied to
// the pool it would leak across requests by construction.
async function asOperator(tx: TransactionDB): Promise<void> {
  await tx`SELECT set_config('application_name', ${OPERATOR_APPLICATION_NAME}, true)`;
}

export { asOperator, createPostgresDb, definedColumns, OPERATOR_APPLICATION_NAME, traced };
export type { GoldDB, PostgresDB, SilverDB, TransactionDB };
