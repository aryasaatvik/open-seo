import { Effect } from "effect";
import { StorageError, type BlobStore } from "@executor-js/sdk/core";

// Executor's blob seam over the app's R2 bucket. Resolved OpenAPI documents
// and their derived definitions are hundreds of KiB each; D1 caps a value
// near 1 MiB, so they live here under one prefix instead.
const PREFIX = "executor-blobs";

const keyFor = (namespace: string, key: string) =>
  `${PREFIX}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;

const storage = (message: string) => (cause: unknown) =>
  new StorageError({ message, cause });

export function makeR2BlobStore(bucket: R2Bucket): BlobStore {
  const get = (namespace: string, key: string) =>
    Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(keyFor(namespace, key));
        return object ? object.text() : null;
      },
      catch: storage("Failed to read blob"),
    });

  return {
    get,
    getMany: (namespaces, key) =>
      Effect.gen(function* () {
        const hits = new Map<string, string>();
        for (const namespace of namespaces) {
          const value = yield* get(namespace, key);
          if (value !== null) hits.set(namespace, value);
        }
        return hits;
      }),
    put: (namespace, key, value) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(keyFor(namespace, key), value);
        },
        catch: storage("Failed to write blob"),
      }),
    delete: (namespace, key) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.delete(keyFor(namespace, key));
        },
        catch: storage("Failed to delete blob"),
      }),
    has: (namespace, key) =>
      Effect.tryPromise({
        try: async () => {
          return (await bucket.head(keyFor(namespace, key))) !== null;
        },
        catch: storage("Failed to check blob"),
      }),
  };
}
