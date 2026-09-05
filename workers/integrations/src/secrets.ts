import { Effect } from "effect";
import {
  ProviderKey,
  StorageError,
  type CredentialProvider,
  type ProviderItemId,
} from "@executor-js/sdk/core";

// The writable credential provider behind every connection this worker
// mints. Values are AES-256-GCM encrypted with a key derived from
// EXECUTOR_SECRET_KEY and stored in a table this worker owns in the shared D1.
// Executor's own encrypted-secrets plugin is not published, and config-level
// providers get no plugin storage, so this is the whole implementation.

const TABLE = "openseo_integration_secrets";
const KEY_SALT = "open-seo/integration-secrets/v1";
const PAYLOAD_VERSION = "v1";
const PROVIDER_KEY = ProviderKey.make("openseo-d1");
// The AES key is derived from this string with a fixed salt, so its entropy
// is the whole defense if the ciphertext leaks. 32 characters is the floor
// `openssl rand -base64 32` clears; the deploy preflight enforces the same.
const MIN_MASTER_KEY_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// Built over a fresh ArrayBuffer so the result satisfies BufferSource under
// both the DOM and workers-types libs.
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function deriveKey(master: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(master),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(KEY_SALT),
      iterations: 100_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext),
    ),
  );
  return [PAYLOAD_VERSION, toBase64(iv), toBase64(ciphertext)].join(".");
}

async function decrypt(key: CryptoKey, payload: string): Promise<string> {
  const [version, iv, ciphertext] = payload.split(".");
  if (version !== PAYLOAD_VERSION || !iv || !ciphertext) {
    throw new Error("Unrecognized secret payload");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return decoder.decode(plaintext);
}

export async function ensureSecretsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS "${TABLE}" (id text PRIMARY KEY NOT NULL, payload text NOT NULL, updated_at text NOT NULL DEFAULT (current_timestamp))`,
    )
    .run();
}

// Non-secret bookkeeping values (digests, markers) share the table under
// reserved ids and are stored in the clear.
const MARKER_PREFIX = "marker:";

export async function readMarker(
  db: D1Database,
  id: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT payload FROM "${TABLE}" WHERE id = ?`)
    .bind(`${MARKER_PREFIX}${id}`)
    .first<{ payload: string }>();
  return row?.payload ?? null;
}

export async function writeMarker(
  db: D1Database,
  id: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO "${TABLE}" (id, payload, updated_at) VALUES (?, ?, current_timestamp)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = current_timestamp`,
    )
    .bind(`${MARKER_PREFIX}${id}`, value)
    .run();
}

export function makeD1SecretProvider(
  db: D1Database,
  masterKey: string,
): CredentialProvider {
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `EXECUTOR_SECRET_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters (openssl rand -base64 32)`,
    );
  }
  const keyPromise = deriveKey(masterKey);
  const storage = (message: string) => (cause: unknown) =>
    new StorageError({ message, cause });

  return {
    key: PROVIDER_KEY,
    writable: true,
    get: (id: ProviderItemId) =>
      Effect.tryPromise({
        try: async () => {
          const row = await db
            .prepare(`SELECT payload FROM "${TABLE}" WHERE id = ?`)
            .bind(String(id))
            .first<{ payload: string }>();
          return row ? decrypt(await keyPromise, row.payload) : null;
        },
        catch: storage("Failed to read secret"),
      }),
    has: (id: ProviderItemId) =>
      Effect.tryPromise({
        try: async () => {
          const row = await db
            .prepare(`SELECT 1 AS present FROM "${TABLE}" WHERE id = ?`)
            .bind(String(id))
            .first();
          return row !== null;
        },
        catch: storage("Failed to check secret"),
      }),
    set: (id: ProviderItemId, value: string) =>
      Effect.tryPromise({
        try: async () => {
          const payload = await encrypt(await keyPromise, value);
          await db
            .prepare(
              `INSERT INTO "${TABLE}" (id, payload, updated_at) VALUES (?, ?, current_timestamp)
               ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = current_timestamp`,
            )
            .bind(String(id), payload)
            .run();
        },
        catch: storage("Failed to write secret"),
      }),
    delete: (id: ProviderItemId) =>
      Effect.tryPromise({
        try: async () => {
          await db
            .prepare(`DELETE FROM "${TABLE}" WHERE id = ?`)
            .bind(String(id))
            .run();
        },
        catch: storage("Failed to delete secret"),
      }),
  };
}
