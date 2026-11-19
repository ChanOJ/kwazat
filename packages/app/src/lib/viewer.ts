import { headers } from "next/headers";
import { cache } from "react";
import { getAuth } from "./auth.ts";

export type Viewer = {
  id: string;
  email: string;
  twoFactorEnabled: boolean;
  twoFactorMethod: "email" | "totp" | null;
  locale: string | null;
};

/**
 * The logged-in user, or null, once per request. Display only: access is decided by the proxy.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  // headers() first: it marks every page as dynamic before anything touches the database.
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const { id, email, twoFactorEnabled, twoFactorMethod, locale } = session.user;
  return {
    id,
    email,
    twoFactorEnabled: !!twoFactorEnabled,
    twoFactorMethod: twoFactorMethod === "email" || twoFactorMethod === "totp" ? twoFactorMethod : null,
    locale: locale ?? null,
  };
});
