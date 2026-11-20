"use server";

import { headers } from "next/headers";
import QRCode from "qrcode";
import { eq, twoFactors, users } from "@kwazat/db";
import { getAuth } from "@/lib/auth.ts";
import { getDb } from "@/lib/db.ts";
import { forgetPassword, rememberedPassword } from "@/lib/signup-secret.ts";
import { clientIp, hit, LIMITS, passwordChecks, RESEND_SECONDS, sendChecks, waitMinutes } from "@/lib/rate-limit.ts";

export type Method = "email" | "totp";

/**
 * `error` is a message key of the "twoFactor" namespace, `minutes` its value for "tooMany".
 * `resendIn` is the resend countdown in seconds, restarted whenever `sentAt` (ms) changes.
 */
type Problem = { error?: string; minutes?: number };
export type EnrollState =
  | ({ step: "choose" } & Problem)
  | ({ step: "verify"; method: Method; qrSvg?: string; totpURI?: string; backupCodes?: string[]; sentAt?: number; resendIn?: number; resent?: boolean } & Problem)
  | { step: "done"; method: Method; backupCodes?: string[] };

const tooMany = (wait: number): Problem => ({ error: "tooMany", minutes: waitMinutes(wait) });

async function currentUser() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not logged in");
  return { auth, user: session.user };
}

async function passwordIsRight(userId: string, password: string): Promise<boolean> {
  const ctx = await (await getAuth()).$context;
  const credential = (await ctx.internalAdapter.findAccounts(userId)).find((a) => a.providerId === "credential");
  return !!credential?.password && (await ctx.password.verify({ hash: credential.password, password }));
}

/**
 * Step 1: check the password, then either email a code (email) or create a new authenticator
 * secret (TOTP). Nothing changes for the account until step 2 succeeds.
 */
async function startEnrollment(_: EnrollState, formData: FormData): Promise<EnrollState> {
  const method: Method = formData.get("method") === "totp" ? "totp" : "email";
  const { auth, user } = await currentUser();
  // Just after signup the password comes from the encrypted cookie (see lib/signup-secret.ts).
  const password = String(formData.get("password") ?? "") || (await rememberedPassword(user.id)) || "";
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  const passwordWait = hit(passwordChecks(ip, user.email));
  if (passwordWait > 0) return { step: "choose", ...tooMany(passwordWait) };
  if (!(await passwordIsRight(user.id, password))) return { step: "choose", error: "wrongPassword" };
  if (method === "email") {
    const wait = hit(sendChecks(ip, user.email));
    if (wait > 0) return { step: "choose", ...tooMany(wait) };
    await auth.api.sendTwoFactorOTP({ headers: requestHeaders });
    return { step: "verify", method, sentAt: Date.now(), resendIn: RESEND_SECONDS };
  }
  // A verified authenticator must be replaced, not doubled: mark it unverified first.
  const db = await getDb();
  await db.update(twoFactors).set({ verified: false }).where(eq(twoFactors.userId, user.id));
  const enabled = await auth.api.enableTwoFactor({ body: { password, method: "totp" }, headers: requestHeaders });
  if (enabled.method !== "totp") throw new Error("Unexpected two-factor method");
  const { totpURI, backupCodes } = enabled;
  const qrSvg = await QRCode.toString(totpURI, { type: "svg", margin: 1 });
  return { step: "verify", method, qrSvg, totpURI, backupCodes };
}

/** Step 2: check the code; the method becomes the account's only second factor. */
async function confirmEnrollment(state: EnrollState, formData: FormData): Promise<EnrollState> {
  if (state.step !== "verify") return { step: "choose" };
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  const { auth, user } = await currentUser();
  const requestHeaders = await headers();
  const wait = hit([[`code:ip:${clientIp(requestHeaders)}`, LIMITS.codePerIp]]);
  if (wait > 0) return { ...state, resent: false, ...tooMany(wait) };
  try {
    if (state.method === "totp") await auth.api.verifyTOTP({ body: { code }, headers: requestHeaders });
    else await auth.api.verifyTwoFactorOTP({ body: { code }, headers: requestHeaders });
  } catch {
    return { ...state, resent: false, error: "wrongCode" };
  }
  const db = await getDb();
  await db.update(users).set({ twoFactorEnabled: true, twoFactorMethod: state.method, updatedAt: new Date() }).where(eq(users.id, user.id));
  // Email only: the authenticator secret and its backup codes stop working.
  if (state.method === "email") await db.delete(twoFactors).where(eq(twoFactors.userId, user.id));
  await forgetPassword();
  return { step: "done", method: state.method, backupCodes: state.backupCodes };
}

/** One action for the whole flow, driven by the form's `op` (for useActionState). */
export async function enroll(state: EnrollState, formData: FormData): Promise<EnrollState> {
  switch (formData.get("op")) {
    case "start":
      return startEnrollment(state, formData);
    case "confirm":
      return confirmEnrollment(state, formData);
    case "resend": {
      if (state.step !== "verify" || state.method !== "email") return state;
      const { auth, user } = await currentUser();
      const requestHeaders = await headers();
      const wait = hit(sendChecks(clientIp(requestHeaders), user.email));
      if (wait > 0) return { ...state, resent: false, sentAt: Date.now(), resendIn: wait, ...tooMany(wait) };
      await auth.api.sendTwoFactorOTP({ headers: requestHeaders });
      return { ...state, error: undefined, minutes: undefined, resent: true, sentAt: Date.now(), resendIn: RESEND_SECONDS };
    }
    default:
      return { step: "choose" };
  }
}
