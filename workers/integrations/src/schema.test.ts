import { describe, expect, it, vi } from "vitest";
import { fingerprintTable, prepareSchema } from "./schema";
import { makeD1, tableNames } from "./test-support/d1";

const NAMESPACE = "test";
const TABLES = ["integration", "connection"];

async function storedFingerprint(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT fingerprint FROM "${fingerprintTable(NAMESPACE)}"`)
    .first<{ fingerprint: string }>();
  return row?.fingerprint ?? null;
}

describe("prepareSchema", () => {
  it("refuses a first bring-up when an Executor table name already exists", async () => {
    const db = makeD1();
    await db.prepare(`CREATE TABLE integration (id text)`).run();
    const ensureSchema = vi.fn();

    await expect(
      prepareSchema(db, NAMESPACE, {
        tableNames: TABLES,
        expectedFingerprint: "abc",
        ensureSchema,
      }),
    ).rejects.toThrow(/collide.*integration/);
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it("resumes after an interrupted first setup instead of reporting its own tables as collisions", async () => {
    const db = makeD1();
    // First attempt creates a table and dies before the fingerprint is final.
    const ensureSchema = vi
      .fn()
      .mockImplementationOnce(async () => {
        await db
          .prepare(`CREATE TABLE IF NOT EXISTS integration (id text)`)
          .run();
        throw new Error("D1 went away");
      })
      .mockImplementation(async () => {
        await db
          .prepare(`CREATE TABLE IF NOT EXISTS integration (id text)`)
          .run();
        await db
          .prepare(`CREATE TABLE IF NOT EXISTS connection (id text)`)
          .run();
      });
    const preparation = {
      tableNames: TABLES,
      expectedFingerprint: "abc",
      ensureSchema,
    };

    await expect(prepareSchema(db, NAMESPACE, preparation)).rejects.toThrow(
      "D1 went away",
    );
    expect(await storedFingerprint(db)).toBe("pending:abc");

    await prepareSchema(db, NAMESPACE, preparation);
    expect(await storedFingerprint(db)).toBe("abc");
    expect(await tableNames(db)).toEqual([
      "connection",
      "integration",
      fingerprintTable(NAMESPACE),
    ]);

    // A matching fingerprint is the fast path: no DDL at all.
    await prepareSchema(db, NAMESPACE, preparation);
    expect(ensureSchema).toHaveBeenCalledTimes(2);
  });
});
