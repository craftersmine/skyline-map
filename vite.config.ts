import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Folder CSLMapView writes exports to. Override with CSLMAP_DIR=/path npm run dev
const MAP_DIR = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');

/** Serves the local CSLMapView export folder at /api/maps (dev + preview only). */
function localMaps(): Plugin {
  const handler = (req: any, res: any, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/maps')) return next();
    const list = () => {
      if (!fs.existsSync(MAP_DIR)) return [];
      return fs.readdirSync(MAP_DIR)
        .filter((f) => /\.cslmap(\.gz)?$/i.test(f))
        .map((f) => { const st = fs.statSync(path.join(MAP_DIR, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
    };
    if (url.pathname === '/api/maps' || url.pathname === '/api/maps/') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ dir: MAP_DIR, maps: list() }));
      return;
    }
    // only serve files that are actually in the listing (no path traversal)
    const name = decodeURIComponent(url.pathname.slice('/api/maps/'.length));
    const entry = list().find((m) => m.file === name);
    if (!entry) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(entry.size));
    fs.createReadStream(path.join(MAP_DIR, entry.file)).pipe(res);
  };
  return {
    name: 'local-cslmaps',
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [localMaps()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
