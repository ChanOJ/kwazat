/**
 * Limits for the login and account forms. Better Auth's own rate limiter only sees HTTP requests
 * to /api/auth; our server actions call `auth.api.*` directly and skip it, so they use this one.
 * In memory: per server process, enough for one container (move to Postgres when there are more).
 */

export type Rule = { window: number; max: number };

/** Per client address or per account, in seconds. */
export const LIMITS = {
  /** Password checks (login, account forms): per address and per account. */
  passwordPerIp: { window: 60, max: 5 },
  passwordPerAccount: { window: 15 * 60, max: 10 },
  /** Second-factor codes typed in, per address (each code also allows 5 tries only). */
  codePerIp: { window: 60, max: 10 },
  /** Emailed codes: one every 30 seconds, 5 per hour per account, 20 per hour per address. */
  sendGap: { window: 30, max: 1 },
  sendPerHour: { window: 60 * 60, max: 5 },
  sendPerHourIp: { window: 60 * 60, max: 20 },
} satisfies Record<string, Rule>;

/** Seconds between two emailed codes, shown as a countdown on the resend button. */
export const RESEND_SECONDS = LIMITS.sendGap.window;

type Bucket = { hits: number[] };
const holder = globalThis as unknown as { kwazatRateLimit?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (holder.kwazatRateLimit ??= new Map());

/**
 * Counts one attempt under every key and rule; refused when any is over its limit. Returns the
 * seconds to wait, 0 when allowed. A refused attempt is not counted.
 */
export function hit(checks: [key: string, rule: Rule][], now = Date.now()): number {
  let wait = 0;
  for (const [key, rule] of checks) {
    const hits = (buckets.get(key)?.hits ?? []).filter((t) => t > now - rule.window * 1000);
    buckets.set(key, { hits });
    if (hits.length >= rule.max) wait = Math.max(wait, Math.ceil((hits[hits.length - rule.max]! + rule.window * 1000 - now) / 1000));
  }
  if (wait > 0) return wait;
  for (const [key] of checks) buckets.get(key)!.hits.push(now);
  if (buckets.size > 10_000) prune(now);
  return 0;
}

/** Drops buckets with no hit in the last hour (the longest window). */
function prune(now: number) {
  for (const [key, { hits }] of buckets) if (!hits.some((t) => t > now - 3600_000)) buckets.delete(key);
}

/** Forgets every count (tests). */
export function resetLimits() {
  buckets.clear();
}

/**
 * The client address: the last X-Forwarded-For entry, the one added by the reverse proxy in front
 * of the app (earlier entries come from the client and can be forged; see docs/infrastructure.md).
 * Locally there is no proxy: every request counts as one address.
 */
export function clientIp(requestHeaders: Headers): string {
  return requestHeaders.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}

/** Minutes to show for a wait in seconds (at least 1). */
export const waitMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/** Limits for an emailed code, per address and per account. */
export function sendChecks(ip: string, account: string): [string, Rule][] {
  return [
    [`send-gap:ip:${ip}`, LIMITS.sendGap],
    [`send-hour:ip:${ip}`, LIMITS.sendPerHourIp],
    [`send-gap:acct:${account}`, LIMITS.sendGap],
    [`send-hour:acct:${account}`, LIMITS.sendPerHour],
  ];
}

/** Limits for a password check, per address and per account. */
export function passwordChecks(ip: string, account: string): [string, Rule][] {
  return [
    [`password:ip:${ip}`, LIMITS.passwordPerIp],
    [`password:acct:${account}`, LIMITS.passwordPerAccount],
  ];
}
