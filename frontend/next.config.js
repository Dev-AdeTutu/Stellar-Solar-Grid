const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.plugins.push(
      new webpack.DefinePlugin({
        'import.meta.env': JSON.stringify({
          VITE_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
          VITE_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org',
          VITE_NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
          VITE_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001',
          VITE_SMS_SHORTCODE: process.env.NEXT_PUBLIC_SMS_SHORTCODE || '20880',
          VITE_SMS_WEBHOOK_DOCS: process.env.NEXT_PUBLIC_SMS_WEBHOOK_DOCS || '',
        })
      })
    );
    return config;
  }
};

module.exports = nextConfig;
