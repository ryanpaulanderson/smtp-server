import type { NextConfig } from "next";

/** Build the same standalone server used by the local acceptance environment. */
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
