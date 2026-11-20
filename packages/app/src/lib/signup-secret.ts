import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { secret } from "./auth.ts";

/**
 * Right after signup the password is kept for a few minutes in an encrypted cookie, so the
 * second-factor setup (which Better Auth only allows with the password) does not ask for it
 * again. AES-256-GCM with a key derived from the auth secret, bound to the user, httpOnly,
 * limited to /settings, deleted as soon as the second factor is confirmed.
 */
export const SIGNUP_COOKIE = "kwazat_signup_pw";
const TTL_SECONDS = 15 * 60;

const key = () => Buffer.from(hkdfSync("sha256", secret(), "kwazat", "signup-password", 32));

export function seal(userId: string, password: string, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ u: userId, p: password, e: now + TTL_SECONDS * 1000 }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

/** The password, when the token is genuine, for this user and not expired. */
export function open(token: string | undefined, userId: string, now = Date.now()): string | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const { u, p, e } = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    return u === userId && typeof p === "string" && typeof e === "number" && e > now ? p : null;
  } catch {
    return null;
  }
}

export async function rememberPassword(userId: string, password: string): Promise<void> {
  (await cookies()).set(SIGNUP_COOKIE, seal(userId, password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/settings",
    maxAge: TTL_SECONDS,
  });
}

export async function rememberedPassword(userId: string): Promise<string | null> {
  return open((await cookies()).get(SIGNUP_COOKIE)?.value, userId);
}

export async function forgetPassword(): Promise<void> {
  (await cookies()).delete({ name: SIGNUP_COOKIE, path: "/settings" });
}

/**
 * The password typed on the login screen when "Create account" is chosen, carried to the signup
 * screen to pre-fill its first password field. Same encryption, bound to the address, 5 minutes,
 * /signup only, deleted once the account is created.
 */
export const PREFILL_COOKIE = "kwazat_signup_prefill";

export async function setPrefill(email: string, password: string): Promise<void> {
  (await cookies()).set(PREFILL_COOKIE, seal(email, password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/signup",
    maxAge: 5 * 60,
  });
}

export async function getPrefill(email: string): Promise<string> {
  return open((await cookies()).get(PREFILL_COOKIE)?.value, email) ?? "";
}

export async function clearPrefill(): Promise<void> {
  (await cookies()).delete({ name: PREFILL_COOKIE, path: "/signup" });
}
