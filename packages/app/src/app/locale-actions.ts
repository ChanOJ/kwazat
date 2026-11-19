"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { eq, users } from "@kwazat/db";
import { isLocale, LOCALE_COOKIE } from "@/i18n/locales.ts";
import { getDb } from "@/lib/db.ts";
import { getViewer } from "@/lib/viewer.ts";

/**
 * Sets the interface language: in the account when logged in, and in a cookie (so it also holds
 * after logging out). "auto" goes back to the browser's language.
 */
export async function setLocale(formData: FormData): Promise<void> {
  const value = formData.get("locale");
  const locale = isLocale(value) ? value : null;
  const viewer = await getViewer();
  if (viewer) {
    const db = await getDb();
    await db.update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, viewer.id));
  }
  const store = await cookies();
  if (locale) store.set(LOCALE_COOKIE, locale, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  else store.delete(LOCALE_COOKIE);
  revalidatePath("/", "layout");
}
