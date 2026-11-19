import { eq, sessions, twoFactors, users, type Db } from "@kwazat/db";
import { createAuth } from "./auth.ts";

/** An error whose message is safe to show: written by us, never containing input values. */
export class CliError extends Error {}

/**
 * Creates an account with a password, or sets the password of an existing one (which logs out
 * all its sessions). The only way accounts are made: there is no signup.
 */
export async function setUser(db: Db, email: string, password: string, mode: "create" | "reset" | "upsert"): Promise<"created" | "updated"> {
  const ctx = await createAuth(db).$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (existing && mode === "create") throw new CliError(`${email} already exists (use: pnpm users password ${email})`);
  if (!existing && mode === "reset") throw new CliError(`No account for ${email}`);
  const hash = await ctx.password.hash(password);
  if (existing) {
    const userId = existing.user.id;
    if (existing.accounts.some((a) => a.providerId === "credential")) await ctx.internalAdapter.updatePassword(userId, hash);
    else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    // A new password logs out every device.
    await db.delete(sessions).where(eq(sessions.userId, userId));
    return "updated";
  }
  const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  return "created";
}

/**
 * Owner recovery for a lost second factor: the account has to set one up again at its next
 * login, and every session is logged out.
 */
export async function resetTwoFactor(db: Db, email: string): Promise<void> {
  const [user] = await db
    .update(users)
    .set({ twoFactorEnabled: false, twoFactorMethod: null, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  if (!user) throw new CliError(`No account for ${email}`);
  await db.delete(twoFactors).where(eq(twoFactors.userId, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
}

/** Second factor by email, already confirmed (local test account only). */
export async function useEmailCodes(db: Db, email: string): Promise<void> {
  const [user] = await db
    .update(users)
    .set({ twoFactorEnabled: true, twoFactorMethod: "email" })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  if (user) await db.delete(twoFactors).where(eq(twoFactors.userId, user.id));
}
