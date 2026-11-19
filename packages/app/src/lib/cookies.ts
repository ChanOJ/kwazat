/**
 * Cookie header for a follow-up call: this request's cookies, replaced by those the Better Auth
 * response just set (a stale login-step cookie would otherwise win).
 */
export function mergedCookies(requestCookie: string | null, responseHeaders: Headers): string {
  const jar = new Map<string, string>();
  const add = (pair: string) => {
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  };
  requestCookie?.split(";").forEach(add);
  responseHeaders.getSetCookie().forEach((c) => add(c.split(";")[0] ?? ""));
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
