import Link from "next/link";
import { signOut } from "./actions.ts";
import { ProfileClose } from "./profile-close.tsx";

/** Profile icon in the top corner; its menu opens without JavaScript (details/summary). */
export function ProfileMenu({ email }: { email: string }) {
  return (
    <details className="profile">
      <ProfileClose />
      <summary aria-label="Profile menu">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
        </svg>
      </summary>
      <div className="profile-menu" role="menu">
        <p className="profile-email">{email}</p>
        <Link href="/account" role="menuitem">
          Account
        </Link>
        <Link href="/red-lines" role="menuitem">
          Red lines
        </Link>
        <form action={signOut}>
          <button type="submit" className="link-button" role="menuitem">
            Log out
          </button>
        </form>
      </div>
    </details>
  );
}

/** Logged out: the same silhouette, dimmed and dashed, with a "?" badge; it leads to login. */
export function AnonymousProfile() {
  return (
    <Link href="/login" className="profile-anonymous" aria-label="Not logged in: log in" title="Not logged in">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
      </svg>
      <span className="profile-badge" aria-hidden="true">
        ?
      </span>
    </Link>
  );
}
