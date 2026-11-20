import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { handleApi } from './server/api.ts';
import { attachRealtime } from './server/realtime.ts';
import { gcImages } from './server/store.ts';

/** Serve the board API + realtime socket from the same origin as the app (dev and preview). */
function brainboardServer(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    void gcImages();
    if (server.httpServer) attachRealtime(server.httpServer as import("node:http").Server);
    server.middlewares.use((req, res, next) => {
      handleApi(req, res).then((handled) => { if (!handled) next(); }, () => next());
    });
  };
  return { name: 'brainboard-server', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig({
  plugins: [brainboardServer()],
  server: { port: 5317, host: 'localhost' },
  preview: { port: 5317, host: 'localhost' },
});
