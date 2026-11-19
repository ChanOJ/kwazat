import { accounts, sessions, users, uuidv7, verifications, type Db } from "@kwazat/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "./db.ts";

/** Only used by `next dev` and tests, against the local PGlite database. */
const DEV_SECRET = "kwazat-local-dev-only-not-a-secret-000000";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_SECRET is required in production");
  return DEV_SECRET;
}

/**
 * Email and password login, sessions in Postgres. Signup is off twice: Better Auth refuses it
 * (`disableSignUp`) and its route does not exist (`disabledPaths`). Accounts come from
 * `pnpm users` only (scripts/users.ts).
 */
export function createAuth(db: Db, opts: { baseURL?: string } = {}) {
  return betterAuth({
    appName: "Kwazat",
    baseURL: opts.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: secret(),
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    disabledPaths: ["/sign-up/email"],
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days, extended while used
      updateAge: 60 * 60 * 24,
    },
    // Login attempts per IP, also in development (default: production only). In memory: per
    // server process, enough for one container.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: { database: { generateId: () => uuidv7() } },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const holder = globalThis as unknown as { kwazatAuth?: Promise<Auth> };

/** The app's auth instance, created on first use (not at build time). */
export function getAuth(): Promise<Auth> {
  holder.kwazatAuth ??= getDb().then((db) => createAuth(db));
  return holder.kwazatAuth;
}
