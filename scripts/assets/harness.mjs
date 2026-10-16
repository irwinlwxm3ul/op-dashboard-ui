// Shared helpers for the asset scripts: a tiny static file server and a headless
// Chromium (SwiftShader WebGL) page that has three.js available through an import map.
// Used by build-*.mjs (conversion pipelines), verify.mjs and preview.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODELS_DIR = path.join(REPO_ROOT, 'public', 'assets', 'models');

const CHROME_PATH = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.fbx': 'application/octet-stream',
};

/**
 * Starts a static server. `mounts` maps URL prefixes (e.g. '/three/') to absolute
 * directories. `/__page.html` serves `pageHtml`. Returns { origin, close }.
 */
export async function startServer(mounts, pageHtml = '<!doctype html><html><body></body></html>') {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/__page.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(pageHtml);
      return;
    }
    for (const [prefix, dir] of entries) {
      if (!url.startsWith(prefix)) continue;
      const rel = url.slice(prefix.length);
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir))) break;
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function pageHtml(extraHead = '') {
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#9aa7b0;overflow:hidden}</style>${extraHead}</head><body></body></html>`;
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

/**
 * Opens a page with three.js mounted and runs `moduleSource` (an ES module body)
 * inside it. The module must call `window.__done(result)` or throw. Extra mounts
 * are merged with the default ones ('/three/' and '/models/').
 * `bindings` are exposed as window functions (e.g. to stream files back to Node).
 */
export async function runInPage(moduleSource, { mounts = {}, viewport = { width: 1280, height: 720 }, bindings = {}, timeoutMs = 300_000 } = {}) {
  const server = await startServer(
    { '/three/': path.join(REPO_ROOT, 'node_modules', 'three'), '/models/': MODELS_DIR, '/scripts/': path.join(REPO_ROOT, 'scripts', 'assets'), ...mounts },
    pageHtml(),
  );
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport });
    const logs = [];
    lastLogs = logs;
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    for (const [name, fn] of Object.entries(bindings)) await page.exposeFunction(name, fn);
    // Built-in: window.__shot(absPath) saves a PNG screenshot of the viewport.
    await page.exposeFunction('__shot', async (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      return true;
    });
    // Built-in: window.__writeFile(absPath, base64) writes binary output (pipelines).
    await page.exposeFunction('__writeFile', async (file, b64) => {
      writeBase64(file, b64);
      return true;
    });
    await page.goto(`${server.origin}/__page.html`);
    const result = await page.evaluate(
      ({ src, timeoutMs }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('page task timed out')), timeoutMs);
          window.__done = (r) => { clearTimeout(timer); resolve(r); };
          window.__fail = (e) => { clearTimeout(timer); reject(new Error(String(e && e.stack || e))); };
          // Module evaluation errors (including top-level await rejections) are
          // reported through the window error events.
          window.addEventListener('error', (ev) => window.__fail(ev.error || ev.message));
          window.addEventListener('unhandledrejection', (ev) => window.__fail(ev.reason));
          const s = document.createElement('script');
          s.type = 'module';
          s.textContent = src;
          document.body.appendChild(s);
        }),
      { src: moduleSource, timeoutMs },
    );
    if (process.env.ASSETS_DEBUG) console.log(logs.join('\n'));
    return { result, logs };
  } catch (e) {
    console.error(logsOf(e));
    throw e;
  } finally {
    await browser.close();
    await server.close();
  }
}

let lastLogs = [];
function logsOf() {
  return lastLogs.slice(-40).join('\n');
}

/** Decodes a base64 string produced in the page (see `toBase64` in page helpers). */
export function writeBase64(file, b64) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}
