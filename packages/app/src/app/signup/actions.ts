"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getAuth } from "@/lib/auth.ts";
import { getDb } from "@/lib/db.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { passwordIssues } from "@/lib/password.ts";
import { clientIp, hit, LIMITS, passwordChecks } from "@/lib/rate-limit.ts";
import { CliError, createAccount } from "@/lib/users.ts";

/**
 * Second screen of the signup: the password, typed twice. Creates the account, logs it in and
 * sends it to the third screen, the second factor (the proxy keeps it there until it is set up).
 */
export async function signUp(formData: FormData): Promise<void> {
  const next = safeNextPath(formData.get("next"));
  const back = (error: string) => redirect(`/signup/password?error=${error}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`);
  const email = await getLoginEmail();
  if (!email) redirect("/login?expired=1");
  const password = String(formData.get("password") ?? "");
  if (password !== String(formData.get("confirmPassword") ?? "")) back("differ");
  if (passwordIssues(password, email).length > 0) back("weak");
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  if (hit([...passwordChecks(ip, email), [`signup:ip:${ip}`, LIMITS.signupPerIp]]) > 0) back("rate");
  const db = await getDb();
  try {
    await createAccount(db, email, password);
  } catch (error) {
    if (error instanceof CliError) back("exists");
    throw error;
  }
  const auth = await getAuth();
  // nextCookies() turns the session cookies of this call into response cookies.
  await auth.api.signInEmail({ body: { email, password }, headers: requestHeaders });
  try {
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: ENROLL_PATH }, headers: requestHeaders });
  } catch {
    // The address can be verified later; the account is already usable.
  }
  redirect(ENROLL_PATH);
}
