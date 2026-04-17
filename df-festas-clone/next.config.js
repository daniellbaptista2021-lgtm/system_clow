/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['df-festas-app.vercel.app'],
    unoptimized: true
  },
  output: 'export',
  trailingSlash: true,
  basePath: '',
}

module.exports = nextConfig