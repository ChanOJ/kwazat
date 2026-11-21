/**
 * Seeded local accounts, created when missing (first start, or after `pnpm app:reset`):
 * - dev@kwazat.localhost: yours. Password from KWAZAT_DEV_PASSWORD (a Proton Pass reference in
 *   secrets.env, resolved by pass-cli); skipped with a warning when the variable is missing.
 * - claude@kwazat.localhost: for Claude sessions. Random password written to
 *   .data/test-account.json (gitignored), never printed.
 * Both are verified and use the email second factor, so the code lands in /dev/mail.
 */
import { openDb, type Db } from "@kwazat/db";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAuth } from "../src/lib/auth.ts";
import { PASSWORD_MAX, PASSWORD_MIN } from "../src/lib/password.ts";
import { setUser, useEmailCodes } from "../src/lib/users.ts";
import { dataDir } from "./dev-lib.ts";

export const DEV_EMAIL = "dev@kwazat.localhost";
export const CLAUDE_EMAIL = "claude@kwazat.localhost";
export const CLAUDE_PASSWORD_FILE = path.join(dataDir, "test-account.json");

async function exists(db: Db, email: string): Promise<boolean> {
  return (await (await createAuth(db).$context).internalAdapter.findUserByEmail(email)) !== null;
}

export async function seedAccounts(db: Db, log: (line: string) => void = console.log): Promise<void> {
  if (!(await exists(db, DEV_EMAIL))) {
    const password = process.env.KWAZAT_DEV_PASSWORD;
    if (!password) {
      log(`warning: ${DEV_EMAIL} not created, KWAZAT_DEV_PASSWORD is not set (run through pass-cli, see README "Local development").`);
    } else if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      log(`warning: ${DEV_EMAIL} not created, KWAZAT_DEV_PASSWORD must have ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    } else {
      await setUser(db, DEV_EMAIL, password, "create");
      await useEmailCodes(db, DEV_EMAIL);
      log(`account ${DEV_EMAIL} created (password from KWAZAT_DEV_PASSWORD).`);
    }
  }
  const hasFile = fs.existsSync(CLAUDE_PASSWORD_FILE);
  if (!(await exists(db, CLAUDE_EMAIL)) || !hasFile) {
    const password = crypto.randomBytes(18).toString("base64url");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(CLAUDE_PASSWORD_FILE, `${JSON.stringify({ email: CLAUDE_EMAIL, password }, null, 2)}\n`, { mode: 0o600 });
    await setUser(db, CLAUDE_EMAIL, password, "upsert");
    await useEmailCodes(db, CLAUDE_EMAIL);
    log(`account ${CLAUDE_EMAIL} ready (password in ${path.relative(process.cwd(), CLAUDE_PASSWORD_FILE) || CLAUDE_PASSWORD_FILE}).`);
  }
}

/** Opens the worktree's database (empty and migrated on first use) and seeds it. */
export async function prepareDatabase(): Promise<void> {
  const db = await openDb();
  try {
    await seedAccounts(db);
  } finally {
    await db.close();
  }
}
