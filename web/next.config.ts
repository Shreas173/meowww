import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * three.js mixes ESM and CJS across its addons; without this, the App Router
   * build can fail to resolve them.
   */
  transpilePackages: ["three"],

  /**
   * Next 16 only trusts `localhost` for dev resources by default. Without this,
   * opening the dev server at http://127.0.0.1:3000 silently serves the page
   * without hydrating it: no errors, just a static, non-scrolling gallery, which
   * is a nasty thing to debug.
   */
  allowedDevOrigins: ["localhost", "127.0.0.1"],

  images: {
    /**
     * Covers are local files under public/. `next/image` still gives lazy
     * loading and reserved layout space, and the optimiser produces a
     * right-sized modern format for the single hero cover per topic.
     */
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
