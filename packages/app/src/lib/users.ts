import { eq, sessions, type Db } from "@kwazat/db";
import { createAuth } from "./auth.ts";

/**
 * Creates an account with a password, or sets the password of an existing one (which logs out
 * all its sessions). The only way accounts are made: there is no signup.
 */
export async function setUser(db: Db, email: string, name: string, password: string, mode: "create" | "reset" | "upsert"): Promise<"created" | "updated"> {
  const ctx = await createAuth(db).$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (existing && mode === "create") throw new Error(`${email} already exists (use: pnpm users password ${email})`);
  if (!existing && mode === "reset") throw new Error(`No account for ${email}`);
  const hash = await ctx.password.hash(password);
  if (existing) {
    const userId = existing.user.id;
    if (existing.accounts.some((a) => a.providerId === "credential")) await ctx.internalAdapter.updatePassword(userId, hash);
    else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
    // A new password logs out every device.
    await db.delete(sessions).where(eq(sessions.userId, userId));
    return "updated";
  }
  const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  return "created";
}
