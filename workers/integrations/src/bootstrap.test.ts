import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ensureDataforseoConnection } from "./bootstrap";
import type { GatewayExecutor } from "./executor";
import { ensureSecretsTable } from "./secrets";
import { makeD1 } from "./test-support/d1";

// A fake of the two Executor surfaces the reconcile touches. `list` reflects
// what `create` and `remove` did, so successive bring-ups see the state the
// previous one left behind.
function fakeExecutor() {
  const names = new Set<string>();
  const create = vi.fn((input: { name: string; value: string }) => {
    names.add(input.name);
    return Effect.void;
  });
  const remove = vi.fn((input: { name: string }) => {
    names.delete(input.name);
    return Effect.void;
  });
  const executor = {
    connections: {
      list: () =>
        Effect.succeed([...names].map((name) => ({ name, owner: "org" }))),
      create,
      remove,
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only connections.list/create/remove are exercised
  } as unknown as GatewayExecutor;
  return { executor, create, remove };
}

describe("ensureDataforseoConnection", () => {
  it("creates the connection once and replaces it when the configured key rotates", async () => {
    const db = makeD1();
    await ensureSecretsTable(db);
    const { executor, create, remove } = fakeExecutor();
    const run = (key: string) =>
      Effect.runPromise(ensureDataforseoConnection(executor, db, key));

    await run("first-key");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "default",
      value: "first-key",
    });

    // Same key on the next bring-up: nothing to do.
    await run("first-key");
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();

    // Rotated key: the stale connection goes and the new value is stored.
    await run("second-key");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ value: "second-key" });

    // And the rotation settles: the new digest matches on the next run.
    await run("second-key");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
