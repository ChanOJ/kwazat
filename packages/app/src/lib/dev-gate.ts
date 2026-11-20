import { timingSafeEqual } from "node:crypto";

/**
 * Preview gate: while the site is not public, visitors without the `dev` cookie only see
 * the waiting page. Opening any URL with `?dev=<key>` sets the cookie (`dev=<key>`) and gives access.
 *
 * It is a soft gate (a shared key, not an account): real access control stays in src/lib/access.ts.
 * The key comes from DEV_ACCESS_KEY; it defaults to "gloubi" outside production only, and in
 * production the gate is closed for everyone while the variable is unset. Set DEV_GATE=off to
 * remove the gate once the site opens.
 */
export const DEV_COOKIE = "dev";
export const DEV_PARAM = "dev";
export const DEV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function devGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_GATE !== "off";
}

export function devKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DEV_ACCESS_KEY || (env.NODE_ENV === "production" ? null : "gloubi");
}

function sameKey(candidate: string | null | undefined, key: string | null): boolean {
  if (!candidate || !key) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `?dev=<key>` carries the right key. */
export function isDevKey(param: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return sameKey(param, devKey(env));
}

/** The cookie holds the key itself, so changing DEV_ACCESS_KEY revokes every earlier cookie. */
export function hasDevCookie(cookie: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return sameKey(cookie, devKey(env));
}
