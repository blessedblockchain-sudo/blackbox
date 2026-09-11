import type { NextConfig } from "next";
import path from "node:path";

// The monorepo root: workspace packages (@blackbox/sdk, @blackbox/compiler) live
// outside apps/web and ship TypeScript sources, so Turbopack must see the root
// and transpile them.
const root = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@blackbox/sdk", "@blackbox/compiler", "@blackbox/attacker"],
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
