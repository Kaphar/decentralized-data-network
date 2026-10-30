/// Script: build the main app + every dApp under src/pages/*/ as independent
/// self-contained outputs under dist/ and dist/dapps/<name>/.
///
/// Run from inside prototypeB/frontend:  `node scripts/build-dapps.js`
///
/// Vite's CLI loads a single config object, so to give each dApp its own outDir
/// we invoke the programmatic `build` API per input set here.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const pagesDir = path.join(root, 'src', 'pages');

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
  // Change CWD to frontend root so Vite resolves index.html correctly
  process.chdir(root);

  // 1) Main app -> dist/
  console.log('[build] main app -> dist/');
  await build({
    ...baseConfig(),
    root,
    build: {
      outDir: distDir,
      rollupOptions: { input: { main: 'index.html' } },
    },
  });

  // 2) Each dApp -> dist/dapps/<name>/  (self-contained)
  if (fs.existsSync(pagesDir)) {
    for (const name of fs.readdirSync(pagesDir)) {
      const dir = path.join(pagesDir, name);
      const html = path.join(dir, 'index.html');
      if (fs.statSync(dir).isDirectory() && fs.existsSync(html)) {
        console.log(`[build] dApp '${name}' -> dist/dapps/${name}/`);
        await build({
          ...baseConfig(),
          root,
          build: {
            outDir: distDir,
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
        const from = path.join(distDir, 'src', 'pages', name, 'index.html');
        const to = path.join(distDir, 'dapps', name, 'index.html');
        if (fs.existsSync(from)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          let htmlContent = fs.readFileSync(from, 'utf8');
          htmlContent = htmlContent.replace(
            /\.\.\/\.\.\/\.\.\/dapps\/[^/]+\/([^\s'"]+)/g,
            (_m, file) => {
              if (file.startsWith('assets/')) return file;
              if (file.startsWith('index-')) return `./${file}`;
              return `assets/${file}`;
            },
          );
          fs.writeFileSync(to, htmlContent);
          fs.unlinkSync(from);
          try { fs.rmdirSync(path.join(distDir, 'src', 'pages', name)); } catch {}
          try { fs.rmdirSync(path.join(distDir, 'src', 'pages')); } catch {}
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
