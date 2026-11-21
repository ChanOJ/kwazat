/**
 * End-to-end encryption of a user's red lines (docs/design/red-lines.md, section 0, Q6), with the
 * Web Crypto API only, so it runs the same in the browser and in Node tests.
 *
 *   data key (AES-GCM 256, random)  encrypts the vault (rules + consent date);
 *   wrapping keys                   each encrypt a copy of the data key ("key wraps"): today a
 *                                   non-extractable key kept on the device; passkey (PRF) and
 *                                   recovery-key wraps come later.
 *
 * The server stores the ciphertext and the wraps, never a key that opens them. Both are bound to
 * the user id through AES-GCM additional data, so a blob copied to another account fails.
 */
import type { RedLine } from "./types.ts";

export type StoredRedLine = RedLine & { enabled: boolean; createdAt: string };

export type Vault = {
  version: 1;
  /** When the user consented to storing their red lines (ISO date-time). */
  consentAt: string;
  rules: StoredRedLine[];
};

export type Sealed = { ciphertext: string; iv: string };
export type KeyWrap = { id: string; kind: "device"; wrapped: string; iv: string; createdAt: string };

const AES = { name: "AES-GCM", length: 256 } as const;
const subtle = () => globalThis.crypto.subtle;

const dataAad = (userId: string) => new TextEncoder().encode(`kwazat:red-lines:v1:data:${userId}`);
const wrapAad = (userId: string) => new TextEncoder().encode(`kwazat:red-lines:v1:wrap:${userId}`);

/** A new random data key. Extractable, so that it can be wrapped for another device or method. */
export function newDataKey(): Promise<CryptoKey> {
  return subtle().generateKey(AES, true, ["encrypt", "decrypt"]);
}

/** A new device wrapping key. Non-extractable: its bytes never reach JavaScript or the server. */
export function newDeviceKey(): Promise<CryptoKey> {
  return subtle().generateKey(AES, false, ["wrapKey", "unwrapKey"]);
}

export async function seal(vault: Vault, dataKey: CryptoKey, userId: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(vault));
  const cipher = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: dataAad(userId) }, dataKey, plain);
  return { ciphertext: toBase64(new Uint8Array(cipher)), iv: toBase64(iv) };
}

/** Decrypts and checks the vault. Throws when the key, the user or the data do not match. */
export async function open(sealed: Sealed, dataKey: CryptoKey, userId: string): Promise<Vault> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: dataAad(userId) },
    dataKey,
    fromBase64(sealed.ciphertext),
  );
  const vault = JSON.parse(new TextDecoder().decode(plain)) as Vault;
  if (vault.version !== 1 || !Array.isArray(vault.rules) || typeof vault.consentAt !== "string") {
    throw new Error("Unsupported red lines vault");
  }
  return vault;
}

export async function wrapDataKey(dataKey: CryptoKey, wrappingKey: CryptoKey, userId: string, id: string, now: Date): Promise<KeyWrap> {
  const iv = randomBytes(12);
  const wrapped = await subtle().wrapKey("raw", dataKey, wrappingKey, { name: "AES-GCM", iv, additionalData: wrapAad(userId) });
  return { id, kind: "device", wrapped: toBase64(new Uint8Array(wrapped)), iv: toBase64(iv), createdAt: now.toISOString() };
}

export function unwrapDataKey(wrap: KeyWrap, wrappingKey: CryptoKey, userId: string): Promise<CryptoKey> {
  return subtle().unwrapKey(
    "raw",
    fromBase64(wrap.wrapped),
    wrappingKey,
    { name: "AES-GCM", iv: fromBase64(wrap.iv), additionalData: wrapAad(userId) },
    AES,
    true,
    ["encrypt", "decrypt"],
  );
}

/** A random id for a key wrap (not secret). */
export function newWrapId(): string {
  return toBase64(randomBytes(12)).replace(/[+/=]/g, "");
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
