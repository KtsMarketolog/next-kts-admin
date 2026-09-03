import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  compress: true,
  poweredByHeader: false,
  output: "standalone",
  cacheMaxMemorySize: 0,
  deploymentId: process.env.DEPLOYMENT_VERSION,
  serverExternalPackages: ["pdfkit"],
  outputFileTracingRoot: __dirname,
  experimental: {
    optimizePackageImports: ["react-select", "@emotion/react"],
    // Only the legacy multipart fallback passes through proxy and is capped at
    // 100 MiB. Large TOP uploads bypass proxy and stream directly to disk.
    // The extra MiB is reserved for multipart headers and field metadata.
    proxyClientMaxBodySize: "101mb",
  },
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [45, 65, 75],
    remotePatterns: [
      { protocol: "https", hostname: "api.kts-impex.ru", pathname: "/uploads/**" },
      { protocol: "http", hostname: "api.kts-impex.ru", pathname: "/uploads/**" },
    ],
  },
  headers: async () => {
    const bitrixWidgetOrigin = "https://crm.kts-impex.ru";
    const bitrixWidgetSocketOrigin = "wss://crm.kts-impex.ru";
    const yandexMapOrigin = "https://yandex.ru";
    const nonIndexableFileHeaders = [
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
    ];
    const scriptSrc = `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${bitrixWidgetOrigin}`;
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          "base-uri 'self'",
          "frame-ancestors 'self'",
          "object-src 'none'",
          `img-src 'self' data: blob: https://api.kts-impex.ru http://api.kts-impex.ru ${bitrixWidgetOrigin}`,
          "font-src 'self' data:",
          "media-src 'self' data: blob:",
          `style-src 'self' 'unsafe-inline' ${bitrixWidgetOrigin}`,
          scriptSrc,
          `connect-src 'self' https://api.kts-impex.ru http://api.kts-impex.ru ${bitrixWidgetOrigin} ${bitrixWidgetSocketOrigin}`,
          `child-src 'self' ${bitrixWidgetOrigin} ${yandexMapOrigin}`,
          `frame-src 'self' ${bitrixWidgetOrigin} ${yandexMapOrigin}`,
          "worker-src 'self' blob:",
          "manifest-src 'self'",
          "form-action 'self'",
        ].join("; "),
      },
    ];

    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/:all*(js|css|png|jpg|jpeg|gif|svg|webp|avif|woff2|ico)",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/data/:path*",
        headers: nonIndexableFileHeaders,
      },
      {
        source: "/klimatika/prog/firmware/update/:path*",
        headers: nonIndexableFileHeaders,
      },
    ];
  },
};

export default nextConfig;
