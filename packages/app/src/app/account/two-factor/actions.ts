"use server";

import { headers } from "next/headers";
import QRCode from "qrcode";
import { eq, twoFactors, users } from "@kwazat/db";
import { getAuth } from "@/lib/auth.ts";
import { getDb } from "@/lib/db.ts";

export type Method = "email" | "totp";

/** `error` is a message key of the "twoFactor" namespace. */
export type EnrollState =
  | { step: "choose"; error?: string }
  | { step: "verify"; method: Method; qrSvg?: string; totpURI?: string; backupCodes?: string[]; error?: string }
  | { step: "done"; method: Method; backupCodes?: string[] };

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
  const password = String(formData.get("password") ?? "");
  const { auth, user } = await currentUser();
  if (!(await passwordIsRight(user.id, password))) return { step: "choose", error: "wrongPassword" };
  const requestHeaders = await headers();
  if (method === "email") {
    await auth.api.sendTwoFactorOTP({ headers: requestHeaders });
    return { step: "verify", method };
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
  try {
    if (state.method === "totp") await auth.api.verifyTOTP({ body: { code }, headers: requestHeaders });
    else await auth.api.verifyTwoFactorOTP({ body: { code }, headers: requestHeaders });
  } catch {
    return { ...state, error: "wrongCode" };
  }
  const db = await getDb();
  await db.update(users).set({ twoFactorEnabled: true, twoFactorMethod: state.method, updatedAt: new Date() }).where(eq(users.id, user.id));
  // Email only: the authenticator secret and its backup codes stop working.
  if (state.method === "email") await db.delete(twoFactors).where(eq(twoFactors.userId, user.id));
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
      const { auth } = await currentUser();
      await auth.api.sendTwoFactorOTP({ headers: await headers() });
      return { ...state, error: undefined };
    }
    default:
      return { step: "choose" };
  }
}
