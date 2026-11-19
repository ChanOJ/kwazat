import { NextResponse, type NextRequest } from "next/server";
import { access, ENROLL_PATH } from "./lib/access.ts";
import { getAuth } from "./lib/auth.ts";

/**
 * The gate, for every page and endpoint (policy: src/lib/access.ts). Runs on the Node.js runtime
 * and checks the session against the database, so a revoked session is refused at once.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (access(pathname, null) === "allow") return NextResponse.next();

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  const decision = access(pathname, session?.user ?? null);
  if (decision === "allow") return NextResponse.next();

  // Pages: to the login or enrollment page. Anything else: a plain 401 or 403.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse(decision === "login" ? "Unauthorized" : "Second factor required", {
      status: decision === "login" ? 401 : 403,
    });
  }
  if (decision === "enroll") return NextResponse.redirect(new URL(ENROLL_PATH, request.url));
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything but Next.js build assets; the policy decides the rest.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
