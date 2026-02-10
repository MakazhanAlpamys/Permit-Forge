import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Suppress Edge Runtime warnings for Supabase client
  // These warnings occur because @supabase/supabase-js checks process.versions internally
  // but this doesn't affect functionality in Edge Runtime
  serverExternalPackages: ['@supabase/supabase-js', 'pdfjs-dist'],
  
  // Webpack configuration to handle Edge Runtime compatibility
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ignore warnings about process.versions in Edge Runtime
      config.resolve.fallback = {
        ...config.resolve.fallback,
        process: false,
      };
      
      // Externalize pdfjs-dist to avoid bundling issues
      config.externals = [...(config.externals || []), 'canvas', 'pdfjs-dist'];
    }
    return config;
  },
};

export default nextConfig;
