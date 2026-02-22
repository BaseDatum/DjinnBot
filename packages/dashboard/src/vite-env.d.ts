/// <reference types="vite/client" />

/** Baked in at build time by vite.config.ts from VITE_API_URL. */
declare const __API_URL__: string;

/** Baked in at build time by vite.config.ts from VITE_APP_VERSION. */
declare const __APP_VERSION__: string;

/** Injected at container startup by entrypoint.sh (runtime override). */
interface Window {
  __RUNTIME_CONFIG__?: {
    API_URL?: string;
    APP_VERSION?: string;
  };
}
