import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Raise Server Action body size limit to allow PDF uploads up to 100 MB.
  // Default is 1 MB which causes 400 errors for any realistic PDF file.
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },

  // Suppress Edge Runtime warnings for Supabase client
  // These warnings occur because @supabase/supabase-js checks process.versions internally
  // but this doesn't affect functionality in Edge Runtime
  serverExternalPackages: ['@supabase/supabase-js', 'pdfjs-dist', 'pdfkit'],
  
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
