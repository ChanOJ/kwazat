import { NextResponse, type NextRequest } from "next/server";
import { needsLogin } from "./lib/access.ts";
import { getAuth } from "./lib/auth.ts";

/**
 * The login gate, for every page and endpoint (see src/lib/access.ts for the policy). Runs on
 * the Node.js runtime and checks the session against the database, so a revoked session is
 * refused at once.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!needsLogin(pathname)) return NextResponse.next();

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) return NextResponse.next();

  // Pages: to the login page, coming back here afterwards. Anything else: a plain 401.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything but Next.js build assets; the policy decides the rest.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
