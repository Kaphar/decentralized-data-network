/// Script: build the main app + every dApp under src/pages/*/ as independent
/// self-contained outputs under dist/ and dist/dapps/<name>/.
///
/// Run from inside prototypeB/frontend:  `node scripts/build-dapps.js`
///
/// Vite's CLI loads a single config object, so to give each dApp its own outDir
/// we invoke the programmatic `build` API per input set here.
import fs from 'fs';
import path from 'path';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

function baseConfig() {
  return {
    plugins: [solid()],
    base: './',
    server: {
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
        '/ws/events': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
        '/dapp': { target: 'http://localhost:3000', changeOrigin: true },
      },
    },
  };
}

async function main() {
  // 1) Main app -> dist/
  console.log('[build] main app -> dist/');
  await build({
    ...baseConfig(),
    build: {
      outDir: 'dist',
      rollupOptions: { input: { main: 'index.html' } },
    },
  });

  // 2) Each dApp -> dist/dapps/<name>/  (self-contained)
  const PAGES = 'src/pages';
  if (fs.existsSync(PAGES)) {
    for (const name of fs.readdirSync(PAGES)) {
      const dir = path.join(PAGES, name);
      const html = path.join(dir, 'index.html');
      if (fs.statSync(dir).isDirectory() && fs.existsSync(html)) {
        console.log(`[build] dApp '${name}' -> dist/dapps/${name}/`);
        await build({
          ...baseConfig(),
          build: {
            // Vite mirrors the input source path for HTML output, so the dApp
            // HTML lands at dist/src/pages/<name>/index.html. We relocate it
            // to dist/dapps/<name>/index.html below. JS/CSS go straight to
            // dapps/<name>/ via the output naming.
            outDir: 'dist',
            emptyOutDir: false,
            rollupOptions: {
              input: { [name]: html },
              output: {
                entryFileNames: 'dapps/[name]/index-[hash].js',
                chunkFileNames: 'dapps/[name]/[name]-[hash].js',
                assetFileNames: 'dapps/[name]/assets/[name]-[hash].[ext]',
              },
            },
          },
        });
        // Relocate the mirrored HTML into dist/dapps/<name>/index.html, and fix
        // its asset references: Vite computed them relative to the source path
        // (src/pages/<name>/index.html), but the HTML now lives at
        // dist/dapps/<name>/index.html, so refs must become `assets/...` and
        // `./index-*.js`.
        const from = path.join('dist', PAGES, name, 'index.html');
        const to = path.join('dist', 'dapps', name, 'index.html');
        if (fs.existsSync(from)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          let html = fs.readFileSync(from, 'utf8');
          // Rewrite <script src> and <link href> that point at ../dapps/<name>/...
          // to relative refs rooted at this (new) HTML location.
          html = html.replace(
            /\.\.\/\.\.\/\.\.\/dapps\/[^/]+\/([^\s'"]+)/g,
            (_m, file) => {
              if (file.startsWith('assets/')) return file;   // already correctly rooted
              if (file.startsWith('index-')) return `./${file}`; // entry chunk
              return `assets/${file}`;
            },
          );
          fs.writeFileSync(to, html);
          fs.unlinkSync(from);
          try { fs.rmdirSync(path.join('dist', PAGES, name)); } catch {}
          try { fs.rmdirSync(path.join('dist', PAGES)); } catch {}
        }
      }
    }
  }
  console.log('[build] done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
