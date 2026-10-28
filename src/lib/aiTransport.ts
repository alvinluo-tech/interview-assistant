import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import type { AiFetch } from './aiProtocol';

export const aiFetch: AiFetch = (url, init) => {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    // Never redirect a request containing a user-provided credential.
    return nativeFetch(url, { ...init, connectTimeout: 15000, maxRedirections: 0 });
  }
  return fetch(url, init);
};
