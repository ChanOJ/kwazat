"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isTheme, THEME_COOKIE } from "@/lib/theme.ts";

/** Stores the theme in a cookie (same for logged-in and anonymous visits); "device" removes it. */
export async function setTheme(formData: FormData): Promise<void> {
  const value = formData.get("theme");
  const store = await cookies();
  if (isTheme(value) && value !== "device") store.set(THEME_COOKIE, value, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  else store.delete(THEME_COOKIE);
  revalidatePath("/", "layout");
}
