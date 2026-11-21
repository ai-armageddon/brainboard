import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { handleApi } from './server/api.ts';
import { attachRealtime } from './server/realtime.ts';
import { gcImages } from './server/store.ts';
import { shareMeta } from './server/meta.ts';
import { PUBLIC_URL } from './server/config.ts';

/** Serve the board API + realtime socket from the same origin as the app (dev and preview). */
function brainboardServer(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    void gcImages();
    if (server.httpServer) attachRealtime(server.httpServer as import("node:http").Server);
    server.middlewares.use((req, res, next) => {
      handleApi(req, res).then((handled) => { if (!handled) next(); }, () => next());
    });
  };
  return {
    name: 'brainboard-server', configureServer: mount, configurePreviewServer: mount,
    // Same link previews for invite links as the production server gives.
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => ctx.originalUrl?.includes('invite=')
        ? shareMeta(html, ctx.originalUrl, PUBLIC_URL ?? `http://localhost:${ctx.server?.config.server.port ?? 5317}`)
        : html,
    },
  };
}

export default defineConfig({
  plugins: [brainboardServer()],
  server: { port: 5317, host: 'localhost' },
  preview: { port: 5317, host: 'localhost' },
});
