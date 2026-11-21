import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
  // Workspace packages are TypeScript sources (imports with .ts extensions).
  transpilePackages: ["@kwazat/db", "@kwazat/researcher"],
  // PGlite loads its WebAssembly and extension files from disk at run time.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  // Dev servers are reached as <topic>.kwazat.localhost through the local proxy (scripts/dev.ts).
  allowedDevOrigins: ["*.kwazat.localhost"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Phase 1: the whole site is private, nothing is indexed.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

// Interface language without locale prefixes in URLs: see src/i18n/request.ts.
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
