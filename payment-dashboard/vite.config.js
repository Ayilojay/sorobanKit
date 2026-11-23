import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { visualizer } from 'rollup-plugin-visualizer'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Deployment base path. Defaults to root ('/') so the dashboard can be
  // served from the domain root; set VITE_BASE_PATH (e.g. '/app/') to
  // deploy under a subdirectory without changing any code.
  const base = env.VITE_BASE_PATH || '/'

  // Normalise the base path into a start_url that always begins and ends with
  // a slash so the manifest resolves correctly when deployed under a
  // subdirectory (e.g. '/app/' -> '/app/').
  const startUrl = base.endsWith('/') ? base : `${base}/`

  // Read-only offline mode (#449): the service worker caches ONLY eligible,
  // non-secret GET responses. Auth, signing material, and every mutating
  // (POST/PUT/PATCH/DELETE) request are explicitly excluded so financial
  // operations are never queued and signing material is never persisted.
  const OFFLINE_CACHE = 'dashboard-offline-v1'
  const OFFLINE_MAX_AGE_SECONDS = 60 * 60 * 24 // 24h freshness ceiling

  return {
    base,
    plugins: [
      react(),
      nodePolyfills({
        // The generated contract bindings (packages/types) import "buffer"
        // directly; resolving it to the real npm package (hoisted by npm)
        // avoids the plugin's alias shim, which does not resolve for files
        // outside the dashboard root.
        exclude: ['buffer'],
      }),
      // Bundle size analysis: `npm run analyze` (vite build --mode analyze)
      // emits dist/stats.html with a treemap of the production bundle.
      mode === 'analyze' &&
        visualizer({
          filename: 'dist/stats.html',
          template: 'treemap',
          gzipSize: true,
          brotliSize: true,
        }),
      // Read-only installable dashboard (#449). The manifest makes the app
      // installable; the Workbox runtime caching allowlist below keeps the
      // offline experience strictly read-only.
      VitePWA({
        registerType: 'autoUpdate',
        // The service worker is only emitted for production builds; dev keeps
        // the plain Vite server so HMR is unaffected.
        devOptions: { enabled: false },
        includeAssets: ['favicon.ico', 'robots.txt', 'sitemap.xml'],
        manifest: {
          name: 'Payment Dashboard',
          short_name: 'Payments',
          description:
            'Read-only payment dashboard available offline for cached, non-secret data.',
          start_url: startUrl,
          scope: base,
          display: 'standalone',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // SPA navigation fallback so deep links resolve from the cached
          // shell while offline.
          navigateFallback: `${startUrl}index.html`,
          // Never fall back for API calls: an offline API request must fail
          // loudly rather than silently return the HTML shell.
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            // Health/status: cheap, non-secret, safe to serve stale.
            {
              urlPattern: ({ url, request }) =>
                request.method === 'GET' &&
                /\/api\/health\/?$/.test(url.pathname),
              handler: 'NetworkFirst',
              options: {
                cacheName: `${OFFLINE_CACHE}-health`,
                networkTimeoutSeconds: 5,
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Address/account lookup metadata: non-secret, read-only.
            {
              urlPattern: ({ url, request }) =>
                request.method === 'GET' &&
                /\/api\/lookup(\/|$)/.test(url.pathname),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: `${OFFLINE_CACHE}-lookup`,
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Federation metadata: non-secret, read-only.
            {
              urlPattern: ({ url, request }) =>
                request.method === 'GET' &&
                /\/api\/federation(\/|$)/.test(url.pathname),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: `${OFFLINE_CACHE}-federation`,
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Static help/FAQ content: non-secret, read-only.
            {
              urlPattern: ({ url, request }) =>
                request.method === 'GET' &&
                /\/faq\.json$/.test(url.pathname),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: `${OFFLINE_CACHE}-faq`,
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: OFFLINE_MAX_AGE_SECONDS,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    define: {
      global: 'globalThis',
    },
    build: {
      chunkSizeWarningLimit: 1100,
      // Per-route JS/asset performance budgets (#450) are enforced by
      // `scripts/check-bundle-budget.mjs`, run after `vite build` in the
      // `build:budget` npm script. The manifest emitted here is the input to
      // that check.
      manifest: true,
      // No `manualChunks` is defined on purpose: the Analytics page (and its
      // charting library) is loaded via React.lazy(() => import(...)), so
      // Rollup's default behaviour emits it as a separate on-demand chunk
      // instead of inlining it into the initial bundle. Forcing all vendor
      // code into one chunk would defeat that split. Verify with
      // `npm run analyze` (dist/stats.html) that the charting library lives in
      // its own chunk.
      // Files in public/ (robots.txt, sitemap.xml, favicons, …) are copied
      // verbatim to the build output root by Vite's default behaviour.
      // The explicit `publicDir` declaration below makes this intent clear and
      // ensures the setting is not accidentally overridden.
    },
    // Explicitly declare the public assets directory so it is obvious which
    // static files (robots.txt, sitemap.xml, …) will be copied to dist/.
    publicDir: 'public',
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:5000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
})
