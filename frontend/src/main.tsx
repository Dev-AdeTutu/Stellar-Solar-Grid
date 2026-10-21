import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker for offline support and background sync.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('sw-update-available'));
            }
          });
        });
      })
      .catch((error) => {
        console.error('Service worker registration failed:', error);
      });
  });
}

// Capture the install prompt so the UI can offer an install flow.
let deferredInstallPrompt: Event | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  window.dispatchEvent(new CustomEvent('pwa-install-available'));
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  window.dispatchEvent(new CustomEvent('pwa-installed'));
});

// Expose a helper the UI can call to trigger the native install prompt.
(window as unknown as { promptPwaInstall?: () => Promise<void> }).promptPwaInstall = async () => {
  const promptEvent = deferredInstallPrompt as (Event & { prompt?: () => Promise<void> }) | null;
  if (!promptEvent || typeof promptEvent.prompt !== 'function') return;
  await promptEvent.prompt();
  deferredInstallPrompt = null;
};
