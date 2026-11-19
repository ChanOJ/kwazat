/**
 * Accounts of the web app. There is no signup page: this command is the only way to create one.
 * Uses DATABASE_URL when set (staging, prod), the local PGlite database otherwise; stop
 * `pnpm dev` first when using PGlite (one process at a time).
 *
 *   pnpm users list
 *   pnpm users add <email> [--name "Display name"]   (asks for the password, hidden)
 *   pnpm users password <email>                      (new password; logs out every session)
 *   pnpm users remove <email>
 *   pnpm users test-account                          (local test account, PGlite only)
 */
import { parseArgs } from "node:util";
import { asc, eq, openDb, users } from "@kwazat/db";
import { createAuth } from "../src/lib/auth.ts";
import { CliError, setUser } from "../src/lib/users.ts";
import { TEST_ACCOUNT } from "../test/test-account.ts";

const USAGE = `Usage: pnpm users list | add <email> [--name N] | password <email> | remove <email> | test-account`;

const { positionals, values } = parseArgs({ allowPositionals: true, options: { name: { type: "string" } } });
const [command, emailArg] = positionals;

/** Reads a line without echoing it on a terminal; reads stdin as is when piped. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          return reject(new CliError("Cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function askPassword(min: number, max: number): Promise<string> {
  const password = await readSecret(`Password (${min} to ${max} characters): `);
  if (password.length < min || password.length > max) throw new CliError(`The password must have ${min} to ${max} characters`);
  if (process.stdin.isTTY && (await readSecret("Same password again: ")) !== password) throw new CliError("The passwords differ");
  return password;
}

/** PGlite allows one process per directory: refuse while `pnpm app` holds the local database. */
async function devServerRunning(): Promise<boolean> {
  try {
    await fetch("http://localhost:3000/api/auth/ok", { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.DATABASE_URL) {
    if (command === "test-account") throw new CliError("test-account only runs against the local PGlite database (unset DATABASE_URL)");
  } else if (await devServerRunning()) {
    throw new CliError("Stop `pnpm app` first: the local database can only be opened by one process at a time");
  }
  const db = await openDb();
  try {
    const { minPasswordLength: min, maxPasswordLength: max } = (await createAuth(db).$context).password.config;
    const email = emailArg?.trim().toLowerCase();
    switch (command) {
      case "list": {
        const rows = await db.select({ email: users.email, name: users.name, createdAt: users.createdAt }).from(users).orderBy(asc(users.createdAt));
        for (const u of rows) console.log(`${u.email}  ${u.name}  (created ${u.createdAt.toISOString().slice(0, 10)})`);
        if (rows.length === 0) console.log("No account yet.");
        return;
      }
      case "add":
      case "password": {
        if (!email) throw new CliError(USAGE);
        const password = await askPassword(min, max);
        const result = await setUser(db, email, values.name ?? email.split("@")[0]!, password, command === "add" ? "create" : "reset");
        console.log(`${email}: ${result}.`);
        return;
      }
      case "remove": {
        if (!email) throw new CliError(USAGE);
        const removed = await db.delete(users).where(eq(users.email, email)).returning({ id: users.id });
        console.log(removed.length ? `${email}: removed, with its sessions.` : `No account for ${email}.`);
        return;
      }
      case "test-account": {
        const result = await setUser(db, TEST_ACCOUNT.email, TEST_ACCOUNT.name, TEST_ACCOUNT.password, "upsert");
        console.log(`${TEST_ACCOUNT.email}: ${result} (password in packages/app/test/test-account.ts).`);
        return;
      }
      default:
        throw new CliError(USAGE);
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  // Only our own messages are shown: an error from a library could carry the password it was
  // given, so it is never printed.
  console.error(error instanceof CliError ? error.message : "Unexpected error (details hidden, they may contain the password).");
  process.exit(1);
});
