/**
 * Who may see what: the only place that decides it. The proxy (src/proxy.ts) enforces it on every
 * request.
 *
 * Browsing and search are open to anyone who gets past the preview gate (src/lib/dev-gate.ts);
 * only PRIVATE_PREFIXES (settings) need a session. There is no signup, accounts are
 * created with `pnpm users`. Set LOGIN_REQUIRED_EVERYWHERE to true to put everything behind login.
 *
 * A second factor is mandatory: a session whose user has none set up can only reach the
 * enrollment page until it is done.
 */
export const LOGIN_REQUIRED_EVERYWHERE = false;

/** Reachable without a session in every phase: login (with its code step) and the auth API. */
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

/** Local development mailbox: emailed codes must be readable before the login is complete. */
const DEV_PUBLIC_PREFIXES = ["/dev/mail"];

/** Need a session in every phase. */
const PRIVATE_PREFIXES = ["/settings"];

/** Where a session without a second factor is sent. */
export const ENROLL_PATH = "/settings/two-factor";

export type Viewer = { twoFactorEnabled?: boolean | null } | null;
export type Decision = "allow" | "login" | "enroll";

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function access(
  pathname: string,
  viewer: Viewer,
  opts: { loginEverywhere?: boolean; development?: boolean } = {},
): Decision {
  const loginEverywhere = opts.loginEverywhere ?? LOGIN_REQUIRED_EVERYWHERE;
  const development = opts.development ?? process.env.NODE_ENV !== "production";
  if (PUBLIC_PREFIXES.some((p) => under(pathname, p))) return "allow";
  if (development && DEV_PUBLIC_PREFIXES.some((p) => under(pathname, p))) return "allow";
  if (viewer && !viewer.twoFactorEnabled) return under(pathname, ENROLL_PATH) ? "allow" : "enroll";
  if (viewer) return "allow";
  const needsLogin = loginEverywhere || PRIVATE_PREFIXES.some((p) => under(pathname, p));
  return needsLogin ? "login" : "allow";
}

/**
 * Where to go after logging in: a path on this site only (no open redirect through `?next=`).
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (under(next, "/login") || under(next, "/api") || under(next, "/dev")) return "/";
  return next;
}
