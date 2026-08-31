/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  
  // Enable static export for Capacitor
  output: 'export',
  
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
  
  // Optional: Change the output directory `out` -> `dist`
  // distDir: 'dist',
  
  // Trailing slash for consistent routing on mobile
  trailingSlash: true,
  
  // Asset prefix for Capacitor
  // Leave empty for relative paths
  assetPrefix: '',
  
  // Environment variables available in the browser
  env: {
    NEXT_PUBLIC_PLATFORM: 'mobile',
  },
  
  // Webpack configuration for Capacitor compatibility
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't resolve 'fs' module on the client to prevent this error on build:
      // Module not found: Can't resolve 'fs'
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    
    return config;
  },
};

module.exports = nextConfig;
