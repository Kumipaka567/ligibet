import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    const msg = (event?.message || '').toLowerCase();
    if (
      msg.includes('unexpected token') ||
      msg.includes('loading chunk') ||
      msg.includes('dynamically imported module') ||
      msg.includes('failed to load module script')
    ) {
      const lastReload = sessionStorage.getItem('chunk_reload_retry');
      if (!lastReload || Date.now() - parseInt(lastReload, 10) > 10000) {
        sessionStorage.setItem('chunk_reload_retry', Date.now().toString());
        window.location.reload();
      }
    }
  });
}

bootstrapApplication(App, appConfig)
  .catch((err) => {
    console.error('Bootstrap error:', err);
    const lastReload = sessionStorage.getItem('chunk_reload_retry');
    if (!lastReload || Date.now() - parseInt(lastReload, 10) > 10000) {
      sessionStorage.setItem('chunk_reload_retry', Date.now().toString());
      window.location.reload();
    }
  });
