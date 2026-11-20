import { NextResponse, type NextRequest } from "next/server";
import { access, ENROLL_PATH } from "./lib/access.ts";
import { getAuth } from "./lib/auth.ts";
import { DEV_COOKIE, DEV_COOKIE_MAX_AGE, DEV_PARAM, devGateEnabled, hasDevCookie, isDevKey } from "./lib/dev-gate.ts";
import { WAITING_PAGE } from "./lib/waiting-page.ts";

/**
 * Two gates, for every page and endpoint. First the preview gate (src/lib/dev-gate.ts): without
 * the dev cookie, only the waiting page. Then the access policy (src/lib/access.ts). Runs on the Node.js runtime
 * and checks the session against the database, so a revoked session is refused at once.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (devGateEnabled()) {
    const key = request.nextUrl.searchParams.get(DEV_PARAM);
    if (isDevKey(key)) {
      // Set the cookie, then drop the key from the URL.
      const clean = request.nextUrl.clone();
      clean.searchParams.delete(DEV_PARAM);
      const response = NextResponse.redirect(clean);
      response.cookies.set(DEV_COOKIE, key!, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: DEV_COOKIE_MAX_AGE,
      });
      return response;
    }
    if (!hasDevCookie(request.cookies.get(DEV_COOKIE)?.value)) {
      return new NextResponse(request.method === "HEAD" ? null : WAITING_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  // Anonymous and allowed: no database lookup. With a session cookie the session is always
  // checked, so a session without a second factor cannot browse the public pages either.
  const hasSessionCookie = request.cookies.getAll().some((c) => c.name.includes("session_token"));
  if (!hasSessionCookie && access(pathname, null) === "allow") return NextResponse.next();

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
