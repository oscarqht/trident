import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  // Disable Turbopack for production builds as keytar is a native module
  // that requires webpack's externals configuration
  experimental: {
    // Use webpack for server-side code
  },
  // Configure webpack to handle native modules
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize keytar - it's a native module that should be loaded at runtime
      config.externals = config.externals || [];
      config.externals.push("keytar");
    }
    return config;
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.google.com",
        pathname: "/s2/favicons",
      },
    ],
  },
  serverExternalPackages: ["keytar"],
};

export default nextConfig;
