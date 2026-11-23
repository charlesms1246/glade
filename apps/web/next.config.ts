import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// One .env at the repo root serves the web app and the worker.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ["@glade/shared", "@glade/engine", "@glade/calendar", "@glade/tm-client", "@glade/stamp", "@glade/db", "@glade/paper"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
