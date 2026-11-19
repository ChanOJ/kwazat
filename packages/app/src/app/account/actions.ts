"use server";

import { headers } from "next/headers";
import { getAuth } from "@/lib/auth.ts";

export type FormState = { ok?: string; error?: string; codes?: string[] };

export async function changeEmail(_: FormState, formData: FormData): Promise<FormState> {
  const newEmail = String(formData.get("newEmail") ?? "").trim().toLowerCase();
  try {
    await (await getAuth()).api.changeEmail({ body: { newEmail, callbackURL: "/account?email=step" }, headers: await headers() });
  } catch {
    return { error: "This address cannot be used." };
  }
  return { ok: "Check your current mailbox: we sent a link to confirm the change. A second link then goes to the new address." };
}

export async function changePassword(_: FormState, formData: FormData): Promise<FormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword !== String(formData.get("confirmPassword") ?? "")) return { error: "The new passwords differ." };
  const auth = await getAuth();
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  if (newPassword.length < minPasswordLength || newPassword.length > maxPasswordLength) {
    return { error: `The new password must have ${minPasswordLength} to ${maxPasswordLength} characters.` };
  }
  try {
    await auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: true }, headers: await headers() });
  } catch {
    return { error: "Wrong current password." };
  }
  return { ok: "Password changed. Your other devices are logged out." };
}

export async function regenerateBackupCodes(_: FormState, formData: FormData): Promise<FormState> {
  const password = String(formData.get("password") ?? "");
  try {
    const { backupCodes } = await (await getAuth()).api.generateBackupCodes({ body: { password }, headers: await headers() });
    return { ok: "New backup codes (the old ones no longer work). They are not shown again:", codes: backupCodes };
  } catch {
    return { error: "Wrong password." };
  }
}
