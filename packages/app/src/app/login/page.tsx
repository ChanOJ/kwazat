import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/access.ts";
import { getAuth } from "@/lib/auth.ts";
import { getViewer } from "@/lib/viewer.ts";

export const metadata: Metadata = { title: "Log in" };

async function logIn(formData: FormData): Promise<void> {
  "use server";
  const next = safeNextPath(formData.get("next"));
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const auth = await getAuth();
  let ok = false;
  try {
    // nextCookies() turns the session cookie of this call into a response cookie.
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
    ok = true;
  } catch {
    // Same message whatever went wrong (unknown email, wrong password, rate limit).
  }
  redirect(ok ? next : `/login?error=1${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  if (await getViewer()) redirect(safeNextPath(next));
  return (
    <section className="login">
      <h1>Log in</h1>
      <p className="lead">Kwazat is in private preview.</p>
      {error && (
        <p className="error" role="alert">
          Wrong email or password, or too many attempts. Try again in a minute.
        </p>
      )}
      <form action={logIn} className="stack">
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Log in</button>
      </form>
    </section>
  );
}
