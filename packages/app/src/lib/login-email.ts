import { cookies } from "next/headers";

/** The address typed on the first login or signup screen, kept for the next screens (30 minutes). */
export const EMAIL_COOKIE = "kwazat_login_email";
export const EMAIL_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 1800 } as const;

export async function getLoginEmail(): Promise<string | null> {
  return (await cookies()).get(EMAIL_COOKIE)?.value || null;
}

/** Loose check, the real test is the confirmation or the login itself. */
export const looksLikeEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
