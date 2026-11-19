import { headers } from "next/headers";
import { getAuth } from "./auth.ts";

export type Viewer = { id: string; name: string; email: string };

/** The logged-in user, or null. Display only: access is decided by the proxy. */
export async function getViewer(): Promise<Viewer | null> {
  // headers() first: it marks every page as dynamic before anything touches the database.
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const { id, name, email } = session.user;
  return { id, name, email };
}
