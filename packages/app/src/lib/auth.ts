import { accounts, sessions, twoFactors, users, uuidv7, verifications, type Db } from "@kwazat/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "../i18n/locales.ts";
import { translator } from "../i18n/messages.ts";
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

/** Language of an email: the account's choice, else the requesting browser's. */
function mailLocale(user: object, requestHeaders?: Headers | null): Locale {
  const account = (user as { locale?: unknown }).locale;
  const cookie = requestHeaders
    ?.get("cookie")
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE)?.[1];
  return resolveLocale({
    account: typeof account === "string" ? account : null,
    cookie,
    acceptLanguage: requestHeaders?.get("accept-language"),
  });
}

/** Minutes an emailed sign-in code stays valid. */
export const EMAIL_CODE_MINUTES = 10;

/**
 * Email and password login plus a mandatory second factor, sessions in Postgres. Better Auth's own
 * signup stays off twice (`disableSignUp` and `disabledPaths`): accounts come from the app's
 * signup form (src/app/signup, which applies the password rules and rate limits and calls
 * `createAccount`) or from `pnpm users` (scripts/users.ts).
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
        locale: { type: "string", required: false, input: false },
      },
      // New address: confirmed from the current address first, then verified at the new one.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }, request) => {
          const t = translator(mailLocale(user, request?.headers), "mail");
          await sendMail({ to: user.email, subject: t("changeSubject"), text: t("changeBody", { newEmail, url }) });
        },
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }, request) => {
        const t = translator(mailLocale(user, request?.headers), "mail");
        await sendMail({ to: user.email, subject: t("verifySubject"), text: t("verifyBody", { url }) });
      },
    },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    disabledPaths: ["/sign-up/email"],
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days, extended while used
      updateAge: 60 * 60 * 24,
    },
    // Direct calls to /api/auth, per IP, also in development (default: production only). In
    // memory: per server process, enough for one container. The app's own forms call `auth.api`
    // from server actions, which skips these rules: they use lib/rate-limit.ts instead.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/send-otp": { window: 30, max: 1 },
        "/two-factor/verify-*": { window: 60, max: 10 },
      },
    },
    advanced: { database: { generateId: () => uuidv7() } },
    telemetry: { enabled: false },
    plugins: [
      twoFactor({
        issuer: "Kwazat",
        otpOptions: {
          period: EMAIL_CODE_MINUTES,
          // Only a hash in the database: a leaked table gives no usable code.
          storeOTP: "hashed",
          // The code, plus a link that opens the code page with it filled in (same browser).
          sendOTP: async ({ user, otp }, ctx) => {
            const t = translator(mailLocale(user, ctx?.headers), "mail");
            await sendMail({
              to: user.email,
              subject: t("codeSubject", { code: otp }),
              text: t("codeBody", { code: otp, url: `${baseURL}/login/code?code=${otp}`, minutes: EMAIL_CODE_MINUTES }),
            });
          },
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
