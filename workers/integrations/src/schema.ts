// Executor shares the app's D1. This module owns the first-boot protocol:
// refuse to run if any table Executor is about to create already exists
// (that would be an OpenSEO table with a colliding name, and
// `CREATE TABLE IF NOT EXISTS` would silently adopt it), then run the
// idempotent DDL and stamp a fingerprint so warm isolates skip all of it.
//
// The fingerprint row is written twice: `pending:<hash>` before any DDL runs,
// then `<hash>` once the schema and the secrets table are in place. A restart
// after an interrupted setup finds the pending row, skips the collision check
// (the tables are ours), and reruns the DDL.

const PENDING_PREFIX = "pending:";

interface SchemaPreparation {
  /** Names of every table the DDL creates. */
  tableNames: readonly string[];
  /** Digest of the DDL; changes when the SDK's schema changes. */
  expectedFingerprint: string;
  /** Runs the idempotent DDL (Executor's tables plus this worker's own). */
  ensureSchema: () => Promise<void>;
}

export function fingerprintTable(namespace: string): string {
  return `private_${namespace}_schema_fingerprint`;
}

export async function fingerprintOf(
  statements: readonly string[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(statements.join("\0")),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function readFingerprint(
  db: D1Database,
  table: string,
): Promise<string | null> {
  const exists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(table)
    .first();
  if (!exists) return null;
  const row = await db
    .prepare(`SELECT fingerprint FROM "${table}" WHERE id = 'runtime'`)
    .first<{ fingerprint: string }>();
  return row?.fingerprint ?? null;
}

async function writeFingerprint(
  db: D1Database,
  table: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY NOT NULL, fingerprint text NOT NULL)`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO "${table}" (id, fingerprint) VALUES ('runtime', ?)
       ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint`,
    )
    .bind(value)
    .run();
}

async function assertNoTableCollision(
  db: D1Database,
  tableNames: readonly string[],
): Promise<void> {
  const placeholders = tableNames.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .bind(...tableNames)
    .all<{ name: string }>();
  if (results.length > 0) {
    throw new Error(
      `Executor tables collide with existing tables in D1: ${results
        .map((r) => r.name)
        .join(", ")}. Rename the app tables or give Executor its own database.`,
    );
  }
}

/**
 * Bring the database to the expected schema. Resolves without touching the
 * database when the stored fingerprint already matches.
 */
export async function prepareSchema(
  db: D1Database,
  namespace: string,
  preparation: SchemaPreparation,
): Promise<void> {
  const table = fingerprintTable(namespace);
  const prepared = await readFingerprint(db, table);
  if (prepared === preparation.expectedFingerprint) return;
  if (prepared === null) {
    await assertNoTableCollision(db, preparation.tableNames);
    await writeFingerprint(
      db,
      table,
      `${PENDING_PREFIX}${preparation.expectedFingerprint}`,
    );
  }
  await preparation.ensureSchema();
  await writeFingerprint(db, table, preparation.expectedFingerprint);
}
