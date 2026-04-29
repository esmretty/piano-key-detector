import { defineConfig } from "vite";
import http from "node:http";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 3001;

/**
 * Manual proxy plugin. The built-in `server.proxy` option silently no-ops
 * on this setup (Vite 7/8 + Node 24 on Windows), so we forward /api/* to
 * the Express backend ourselves via a connect middleware.
 */
const apiProxy = {
  name: "api-proxy",
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (!req.url || !req.url.startsWith("/api/")) return next();
      const proxyReq = http.request(
        {
          host: BACKEND_HOST,
          port: BACKEND_PORT,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", (err) => {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: `後端 (${BACKEND_HOST}:${BACKEND_PORT}) 無回應：${err.message}。請確認 \`npm run dev:backend\` 在跑。`,
          }),
        );
      });
      // Set a generous timeout (multi-page PDF OMR can take minutes).
      proxyReq.setTimeout(10 * 60 * 1000);
      req.pipe(proxyReq);
    });
  },
};

export default defineConfig({
  plugins: [apiProxy],
  server: {
    host: true, // listen on 0.0.0.0 so phones on the LAN can connect
    port: 5173,
    strictPort: true, // fail loudly if 5173 is taken instead of drifting to 5174+
  },
});
