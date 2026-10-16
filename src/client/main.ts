// Browser entry point.
import { initI18n, t } from './i18n';
import { App } from './app/App';

function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function boot(): void {
  initI18n();
  const root = document.getElementById('app');
  if (!root) throw new Error('#app root missing');
  if (!hasWebGL2()) {
    const msg = document.createElement('div');
    msg.className = 'dz-fatal';
    msg.textContent = t('flow.webglUnsupported');
    root.appendChild(msg);
    return;
  }
  const app = new App(root);
  // Handy for debugging and the Playwright smoke tests.
  (window as unknown as { __dz: App }).__dz = app;
}

boot();
