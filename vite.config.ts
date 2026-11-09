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

/**
 * Showcase screenshots: `<img data-shot="d-street" data-sizes="...">` becomes a responsive WebP image
 * (src, srcset, sizes, width, height, lazy loading) from public/showcase/manifest.json, at build and dev time,
 * so the page is plain static markup.
 */
function showcaseShots(): Plugin {
  const manifestPath = path.resolve(__dirname, 'public/showcase/manifest.json');
  return {
    name: 'showcase-shots',
    transformIndexHtml(html, ctx) {
      if (!/(showcase\.html|[\\/]blog[\\/][^\\/]+\.html)$/.test(ctx.filename)) return html;
      const m: Record<string, { w: number; h: number; widths: number[] }> = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return html.replace(/<img([^>]*?)\sdata-shot="([^"]+)"([^>]*)>/g, (_all, pre: string, name: string, post: string) => {
        const s = m[name];
        if (!s) throw new Error(`showcase: no screenshot "${name}"`);
        const attrs = pre + post;
        const sizes = /data-sizes="([^"]+)"/.exec(attrs)?.[1] ?? '100vw';
        const eager = /\sdata-eager/.test(attrs);
        const rest = attrs.replace(/\sdata-sizes="[^"]*"/, '').replace(/\sdata-eager/, '');
        const src = (w: number) => `/showcase/${name}-${w}.webp`;
        const mid = s.widths[Math.min(1, s.widths.length - 1)];
        return `<img${rest} src="${src(mid)}" srcset="${s.widths.map((w) => `${src(w)} ${w}w`).join(', ')}" sizes="${sizes}" width="${s.w}" height="${s.h}" data-full="${src(s.widths[s.widths.length - 1])}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
      });
    },
  };
}

export default defineConfig({
  plugins: [localMaps(), showcaseShots()],
  worker: { format: 'es' },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'), showcase: path.resolve(__dirname, 'showcase.html'), notFound: path.resolve(__dirname, '404.html'), privacy: path.resolve(__dirname, 'privacy.html'),
        // every blog/*.html is a page, served at /blog/<name>
        ...Object.fromEntries(fs.readdirSync(path.resolve(__dirname, 'blog')).filter((f) => f.endsWith('.html')).map((f) => [`blog-${f.slice(0, -5)}`, path.resolve(__dirname, 'blog', f)])),
      },
    },
  },
});
