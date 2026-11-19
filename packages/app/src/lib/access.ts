/**
 * Who may see what: the only place that decides which paths need a session. The proxy
 * (src/proxy.ts) enforces it on every request.
 *
 * Phase 1 (now): everything is behind login while the owner works on the UX; there is no
 * signup, accounts are created with `pnpm users`.
 * Phase 2: set LOGIN_REQUIRED_EVERYWHERE to false. Browsing and search then open to anonymous
 * visitors, and only PRIVATE_PREFIXES (settings, personalization) still need a session.
 */
export const LOGIN_REQUIRED_EVERYWHERE = true;

/** Reachable without a session in every phase: the login page and the auth API itself. */
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

/** Need a session in every phase. */
const PRIVATE_PREFIXES = ["/settings", "/account"];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function needsLogin(pathname: string, loginEverywhere = LOGIN_REQUIRED_EVERYWHERE): boolean {
  if (PUBLIC_PREFIXES.some((p) => under(pathname, p))) return false;
  if (loginEverywhere) return true;
  return PRIVATE_PREFIXES.some((p) => under(pathname, p));
}

/**
 * Where to go after logging in: a path on this site only (no open redirect through `?next=`).
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (under(next, "/login") || under(next, "/api")) return "/";
  return next;
}
