import { accounts, sessions, twoFactors, users, uuidv7, verifications, type Db } from "@kwazat/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getDb } from "./db.ts";
import { sendMail } from "./mail.ts";

/** Only used by `next dev` and tests, against the local PGlite database. */
const DEV_SECRET = "kwazat-local-dev-only-not-a-secret-000000";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("BETTER_AUTH_SECRET is required in production");
  return DEV_SECRET;
}

/** Minutes an emailed sign-in code stays valid. */
export const EMAIL_CODE_MINUTES = 10;

/**
 * Email and password login plus a mandatory second factor, sessions in Postgres. Signup is off
 * twice: Better Auth refuses it (`disableSignUp`) and its route does not exist (`disabledPaths`).
 * Accounts come from `pnpm users` only (scripts/users.ts).
 */
export function createAuth(db: Db, opts: { baseURL?: string } = {}) {
  const baseURL = opts.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return betterAuth({
    appName: "Kwazat",
    baseURL,
    secret: secret(),
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications, twoFactors },
    }),
    user: {
      additionalFields: {
        twoFactorMethod: { type: "string", required: false, input: false },
      },
      // New address: confirmed from the current address first, then verified at the new one.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) =>
          sendMail({
            to: user.email,
            subject: "Confirm your new Kwazat email address",
            text: `Someone (hopefully you) asked to change the email address of your Kwazat account to ${newEmail}.\n\nTo confirm, open:\n${url}\n\nIf it was not you, ignore this message and change your password.`,
          }),
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) =>
        sendMail({
          to: user.email,
          subject: "Verify your Kwazat email address",
          text: `Open this link to verify this address for your Kwazat account:\n${url}`,
        }),
    },
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
    plugins: [
      twoFactor({
        issuer: "Kwazat",
        otpOptions: {
          period: EMAIL_CODE_MINUTES,
          // The code, plus a link that opens the code page with it filled in (same browser).
          sendOTP: async ({ user, otp }) =>
            sendMail({
              to: user.email,
              subject: `${otp} is your Kwazat code`,
              text: `Your Kwazat code: ${otp}\n\nOr open this link in the browser where you are logging in:\n${baseURL}/login/code?code=${otp}\n\nIt expires in ${EMAIL_CODE_MINUTES} minutes. If you did not try to log in, change your password.`,
            }),
        },
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const holder = globalThis as unknown as { kwazatAuth?: Promise<Auth> };

/** The app's auth instance, created on first use (not at build time). */
export function getAuth(): Promise<Auth> {
  holder.kwazatAuth ??= getDb().then((db) => createAuth(db));
  return holder.kwazatAuth;
}
