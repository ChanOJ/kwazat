import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getViewer } from "@/lib/viewer.ts";
import { logIn } from "./actions.ts";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; expired?: string }> }) {
  const { next, error, expired } = await searchParams;
  const viewer = await getViewer();
  if (viewer) redirect(viewer.twoFactorEnabled ? safeNextPath(next) : ENROLL_PATH);
  return (
    <section className="login">
      <h1>Log in</h1>
      <p className="lead">Kwazat is in private preview.</p>
      {error && (
        <p className="error" role="alert">
          Wrong email or password, or too many attempts. Try again in a minute.
        </p>
      )}
      {expired && (
        <p className="error" role="alert">
          The login took too long. Please start again.
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
