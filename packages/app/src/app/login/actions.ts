"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, twoFactors, users } from "@kwazat/db";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getAuth } from "@/lib/auth.ts";
import { getDb } from "@/lib/db.ts";

/** Which second factor the code page asks for (not a secret: it only picks the form). */
const METHOD_COOKIE = "kwazat_2fa_method";

const withNext = (path: string, next: string) => (next === "/" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`);

/** Cookies a Better Auth response sets, as a Cookie header for a follow-up call. */
function cookieHeader(responseHeaders: Headers): string {
  return responseHeaders
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function logIn(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const auth = await getAuth();
  let target = withNext("/login?error=1", next);
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
      (await cookies()).set(METHOD_COOKIE, method, { httpOnly: true, sameSite: "lax", path: "/login", maxAge: 600 });
      if (method === "email") await auth.api.sendTwoFactorOTP({ headers: new Headers({ cookie: cookieHeader(set) }) });
      target = withNext("/login/code", next);
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

export async function verifyCode(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const kind = String(formData.get("kind") ?? "");
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  const trustDevice = formData.get("trustDevice") === "on";
  const auth = await getAuth();
  const requestHeaders = await headers();
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
  if (ok) (await cookies()).delete({ name: METHOD_COOKIE, path: "/login" });
  redirect(ok ? next : withNext("/login/code?error=1", next));
}

export async function resendCode(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  let ok = false;
  try {
    await (await getAuth()).api.sendTwoFactorOTP({ headers: await headers() });
    ok = true;
  } catch {
    // The login step expired: start again.
  }
  redirect(ok ? withNext("/login/code?sent=1", next) : withNext("/login?expired=1", next));
}
