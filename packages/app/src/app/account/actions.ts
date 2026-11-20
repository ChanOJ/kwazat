"use server";

import { headers } from "next/headers";
import { getAuth } from "@/lib/auth.ts";
import { clientIp, hit, passwordChecks, waitMinutes } from "@/lib/rate-limit.ts";

/** Results carry message keys of the "account" namespace, translated by the form. */
export type FormState = { ok?: string; error?: string; values?: Record<string, number>; codes?: string[] };

/** Counts a password check for the logged-in account; the wait in seconds when refused. */
async function passwordWait(): Promise<number> {
  const requestHeaders = await headers();
  const session = await (await getAuth()).api.getSession({ headers: requestHeaders });
  return hit(passwordChecks(clientIp(requestHeaders), session?.user.email ?? "none"));
}

const tooMany = (wait: number): FormState => ({ error: "tooMany", values: { minutes: waitMinutes(wait) } });

export async function changeEmail(_: FormState, formData: FormData): Promise<FormState> {
  const newEmail = String(formData.get("newEmail") ?? "").trim().toLowerCase();
  try {
    await (await getAuth()).api.changeEmail({ body: { newEmail, callbackURL: "/account?email=step" }, headers: await headers() });
  } catch {
    return { error: "emailRefused" };
  }
  return { ok: "emailSent" };
}

export async function changePassword(_: FormState, formData: FormData): Promise<FormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword !== String(formData.get("confirmPassword") ?? "")) return { error: "passwordsDiffer" };
  const auth = await getAuth();
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  if (newPassword.length < minPasswordLength || newPassword.length > maxPasswordLength) {
    return { error: "passwordLength", values: { min: minPasswordLength, max: maxPasswordLength } };
  }
  const wait = await passwordWait();
  if (wait > 0) return tooMany(wait);
  try {
    await auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: true }, headers: await headers() });
  } catch {
    return { error: "wrongCurrent" };
  }
  return { ok: "passwordChanged" };
}

export async function regenerateBackupCodes(_: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  const wait = await passwordWait();
  if (wait > 0) return tooMany(wait);
  try {
    const { backupCodes } = await (await getAuth()).api.generateBackupCodes({ body: { password }, headers: await headers() });
    return { ok: "backupDone", codes: backupCodes };
  } catch {
    return { error: "wrongPassword" };
  }
}
