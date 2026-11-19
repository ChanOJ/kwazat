import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/viewer.ts";
import { BackupCodesForm, EmailForm, PasswordForm } from "./forms.tsx";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const viewer = (await getViewer())!; // the proxy only lets logged-in users here
  const { email } = await searchParams;
  return (
    <section className="account">
      <h1>Account</h1>
      <p className="lead">Kwazat only keeps what logging in needs: your email address, a password and a second factor.</p>
      {email === "step" && (
        <p className="notice">
          Change confirmed. If the address below is not the new one yet, open the link we sent to the new address to finish.
        </p>
      )}

      <section className="panel">
        <h2>Email</h2>
        <p>
          Current address: <strong>{viewer.email}</strong>
        </p>
        <EmailForm current={viewer.email} />
      </section>

      <section className="panel">
        <h2>Password</h2>
        <PasswordForm />
      </section>

      <section className="panel">
        <h2>Second factor</h2>
        <p>
          {viewer.twoFactorMethod === "totp" ? "Authenticator app, with backup codes." : "Code sent by email at each login."}{" "}
          <Link href="/account/two-factor">Change</Link>
        </p>
        {viewer.twoFactorMethod === "totp" && (
          <details>
            <summary>Replace my backup codes</summary>
            <BackupCodesForm />
          </details>
        )}
      </section>
    </section>
  );
}
