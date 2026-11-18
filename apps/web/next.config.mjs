/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: a pure client SPA with no Node server — served on the web (CDN) and inside
  // the desktop shell over the privileged app:// protocol. All dynamic behavior lives in the API.
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@agentos/brand', '@agentos/protocol'],
  // Linting is run as its own monorepo task (turbo run lint), not during the Next build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
