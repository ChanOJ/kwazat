"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, twoFactors, users } from "@kwazat/db";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getAuth } from "@/lib/auth.ts";
import { mergedCookies } from "@/lib/cookies.ts";
import { getDb } from "@/lib/db.ts";
import { EMAIL_COOKIE, EMAIL_COOKIE_OPTIONS, looksLikeEmail } from "@/lib/login-email.ts";
import { clientIp, hit, LIMITS, passwordChecks, sendChecks } from "@/lib/rate-limit.ts";

/** Which second factor the code page asks for (not a secret: it only picks the form). */
const METHOD_COOKIE = "kwazat_2fa_method";
/** When the last code was emailed (ms), for the resend countdown; the limit itself is server-side. */
const SENT_COOKIE = "kwazat_2fa_sent";
const LOGIN_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/login", maxAge: 600 } as const;

const withNext = (path: string, next: string) => (next === "/" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`);

/**
 * First screen: only the address. "Log in" and "Create account" both submit it (the button's
 * `intent`). It says nothing about whether the address has an account.
 */
export async function startLogin(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!looksLikeEmail(email)) redirect(withNext("/login?error=email", next));
  (await cookies()).set(EMAIL_COOKIE, email, EMAIL_COOKIE_OPTIONS);
  if (formData.get("intent") !== "signup") redirect(withNext("/login/password", next));
  // Say so now rather than after two passwords. Rate-limited, since it reveals that an account exists.
  const [existing] = hit(passwordChecks(clientIp(await headers()), email)) > 0 ? [] : await (await getDb()).select({ id: users.id }).from(users).where(eq(users.email, email));
  redirect(withNext(existing ? "/login/password?exists=1" : "/signup/password", next));
}

/** Second screen of the login: the password for the address from the first screen. */
export async function logIn(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const auth = await getAuth();
  const ip = clientIp(await headers());
  let target = withNext("/login/password?error=1", next);
  // Same message as a wrong password: says nothing about the account.
  if (hit(passwordChecks(ip, email)) > 0) redirect(target);
  try {
    // nextCookies() turns the cookies of this call into response cookies.
    const { headers: set, response } = await auth.api.signInEmail({
      body: { email, password },
      headers: await headers(),
      returnHeaders: true,
    });
    if ("twoFactorRedirect" in response && response.twoFactorRedirect) {
      const db = await getDb();
      const [user] = await db
        .select({ method: users.twoFactorMethod, appVerified: twoFactors.verified })
        .from(users)
        .leftJoin(twoFactors, eq(twoFactors.userId, users.id))
        .where(eq(users.email, email));
      // An authenticator being replaced (not confirmed yet) falls back to an emailed code.
      const method = user?.method === "totp" && user.appVerified ? "totp" : "email";
      const jar = await cookies();
      jar.set(METHOD_COOKIE, method, LOGIN_COOKIE_OPTIONS);
      target = withNext("/login/code", next);
      if (method === "email") {
        const wait = hit(sendChecks(ip, email));
        if (wait > 0) {
          target = withNext(`/login/code?wait=${wait}`, next);
        } else {
          // This request's headers (language) plus the login-step cookie Better Auth just set.
          const followUp = new Headers(await headers());
          followUp.set("cookie", mergedCookies(followUp.get("cookie"), set));
          await auth.api.sendTwoFactorOTP({ headers: followUp });
          jar.set(SENT_COOKIE, String(Date.now()), LOGIN_COOKIE_OPTIONS);
        }
      }
    } else {
      // No second factor yet: straight to enrollment (the gate would send every page there).
      const user = "user" in response ? (response.user as { twoFactorEnabled?: boolean | null }) : null;
      target = user?.twoFactorEnabled ? next : ENROLL_PATH;
    }
  } catch {
    // Same message whatever went wrong (unknown email, wrong password, rate limit).
  }
  redirect(target);
}

export async function getMethod(): Promise<"email" | "totp"> {
  return (await cookies()).get(METHOD_COOKIE)?.value === "totp" ? "totp" : "email";
}

/** Seconds before another code can be asked for, as far as this browser knows. */
export async function resendWait(): Promise<number> {
  const sent = Number((await cookies()).get(SENT_COOKIE)?.value);
  if (!Number.isFinite(sent)) return 0;
  return Math.max(0, Math.ceil((sent + LIMITS.sendGap.window * 1000 - Date.now()) / 1000));
}

export async function verifyCode(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const kind = String(formData.get("kind") ?? "");
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  const trustDevice = formData.get("trustDevice") === "on";
  const auth = await getAuth();
  const requestHeaders = await headers();
  const wait = hit([[`code:ip:${clientIp(requestHeaders)}`, LIMITS.codePerIp]]);
  if (wait > 0) redirect(withNext(`/login/code?error=rate&wait=${wait}`, next));
  let ok = false;
  try {
    const body = { code, trustDevice };
    if (kind === "backup") await auth.api.verifyBackupCode({ body, headers: requestHeaders });
    else if ((await getMethod()) === "totp") await auth.api.verifyTOTP({ body, headers: requestHeaders });
    else await auth.api.verifyTwoFactorOTP({ body, headers: requestHeaders });
    ok = true;
  } catch {
    // Wrong, expired or too many attempts: same message.
  }
  if (ok) {
    const jar = await cookies();
    jar.delete({ name: METHOD_COOKIE, path: "/login" });
    jar.delete({ name: SENT_COOKIE, path: "/login" });
    jar.delete({ name: EMAIL_COOKIE, path: "/" });
  }
  redirect(ok ? next : withNext("/login/code?error=1", next));
}

export async function resendCode(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const requestHeaders = await headers();
  const jar = await cookies();
  // The login-step cookie (signed by Better Auth) stands for the account here.
  const step = jar.getAll().find((c) => c.name.endsWith("two_factor"))?.value;
  if (!step) redirect(withNext("/login?expired=1", next));
  const wait = hit(sendChecks(clientIp(requestHeaders), `login:${step}`));
  if (wait > 0) redirect(withNext(`/login/code?wait=${wait}`, next));
  let ok = false;
  try {
    await (await getAuth()).api.sendTwoFactorOTP({ headers: requestHeaders });
    ok = true;
  } catch {
    // The login step expired: start again.
  }
  if (ok) jar.set(SENT_COOKIE, String(Date.now()), LOGIN_COOKIE_OPTIONS);
  redirect(ok ? withNext("/login/code?sent=1", next) : withNext("/login?expired=1", next));
}
