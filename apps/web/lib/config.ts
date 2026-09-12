/**
 * Build mode. The same source tree builds two ways:
 *
 *  - server mode (`next dev` / `next build`, the default): the route handlers in
 *    `app/api/**` are part of the build and the browser talks to them.
 *  - static mode (`NEXT_PUBLIC_STATIC=1`, `output: "export"`): there is no
 *    server. `app/api/**` is excluded from the build (next.config.ts drops the
 *    `api.ts` page extension) and every read the browser needs is done from the
 *    browser: chain RPC, the TEE RPC, and a round baked in at build time.
 *
 * Both flags are inlined by the bundler, so `STATIC` is a compile-time constant
 * and the server-only branches are dropped from the static bundle.
 */
export const STATIC = process.env.NEXT_PUBLIC_STATIC === "1";

/** Path prefix the site is served under (GitLab Pages serves the project at /blackbox/). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * URL of a file in `public/`. `next/link` and the router apply `basePath`
 * themselves; plain `<img>`, `<video>` and `<a href>` do not.
 */
export function asset(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Repository and program links used by the landing page and the footer. */
export const REPO_URL = "https://gitlab.com/Bprime/blackbox";
export const PROGRAM_EXPLORER = "https://explorer.solana.com/address/BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27?cluster=devnet";
