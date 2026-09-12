import type { NextConfig } from "next";
import path from "node:path";

// The monorepo root: workspace packages (@blackbox/sdk, @blackbox/compiler) live
// outside apps/web and ship TypeScript sources, so Turbopack must see the root
// and transpile them.
const root = path.join(__dirname, "../..");

/**
 * Two builds from one tree.
 *
 * Default (`next dev`, `next build`): a Node server. The route handlers in
 * `app/api/**` are named `route.api.ts` and are picked up because "api.ts" is in
 * `pageExtensions`.
 *
 * NEXT_PUBLIC_STATIC=1 (`next build` → `out/`): a static export for GitLab
 * Pages. "api.ts" is dropped from `pageExtensions`, so every `route.api.ts`
 * becomes an ordinary, unreferenced module and no route handler is part of the
 * build — which is what `output: "export"` requires, since those handlers read
 * the request and the local round file. The browser does those three reads
 * itself instead (lib/client-api.ts).
 *
 * NEXT_PUBLIC_BASE_PATH is the sub-path the site is served under
 * (`/blackbox` on GitLab Pages); it is inlined into the client bundle, so it
 * must be set at build time.
 */
const isStatic = process.env.NEXT_PUBLIC_STATIC === "1";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@blackbox/sdk", "@blackbox/compiler", "@blackbox/attacker"],
  turbopack: { root },
  outputFileTracingRoot: root,
  pageExtensions: isStatic ? ["tsx", "ts"] : ["api.ts", "tsx", "ts"],
  ...(isStatic
    ? {
        output: "export" as const,
        // /arena -> out/arena/index.html, which any static host serves directly.
        trailingSlash: true,
        // No image optimizer without a server; the app only uses plain <img>/<video>.
        images: { unoptimized: true },
        ...(basePath ? { basePath, assetPrefix: basePath } : {}),
      }
    : {}),
};

export default nextConfig;
