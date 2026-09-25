import { DatabaseSync } from "node:sqlite";

// The slice of D1's prepared-statement API this worker uses, backed by an
// in-memory SQLite database so tests run real SQL instead of mocking it.
export function makeD1(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      first<T>(): Promise<T | null> {
        const row = sqlite
          .prepare(sql)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:sqlite accepts the same bindable scalars D1 does
          .get(...(params as (string | number | null)[]));
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers name the row shape they selected, as with D1
        return Promise.resolve((row as T | undefined) ?? null);
      },
      all<T>(): Promise<{ results: T[] }> {
        const rows = sqlite
          .prepare(sql)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:sqlite accepts the same bindable scalars D1 does
          .all(...(params as (string | number | null)[]));
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers name the row shape they selected, as with D1
        return Promise.resolve({ results: rows as T[] });
      },
      run(): Promise<unknown> {
        sqlite
          .prepare(sql)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:sqlite accepts the same bindable scalars D1 does
          .run(...(params as (string | number | null)[]));
        return Promise.resolve({});
      },
    };
    return statement;
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only prepare/bind/first/all/run are exercised; the rest of D1Database is never called
  return {
    prepare,
    exec: (sql: string) => sqlite.exec(sql),
  } as unknown as D1Database;
}

export function tableNames(db: D1Database): Promise<string[]> {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .all<{ name: string }>()
    .then(({ results }) => results.map((row) => row.name));
}
