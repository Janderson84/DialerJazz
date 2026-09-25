import { createClient } from '@insforge/sdk';

const rawBase = import.meta.env.VITE_INSFORGE_BASE_URL || 'https://755d753k.ap-southeast.insforge.app';
// The InsForge SDK builds URLs with `new URL('/api/...', baseUrl)` — an absolute
// path DISCARDS any base-path prefix, so the SDK's calls always land on
// `${origin}/api/*`. The public preview tunnel's edge blocks the /api/auth
// prefix, so we pass the SDK a wrapped fetch that redirects its /api/* calls to
// the neutral /_bf prefix (proxied by Vite to the InsForge backend). The app's
// own server calls (api.ts) don't go through this wrapper and are unaffected.
const sdkFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (/^https?:\/\/[^/]+\/api\//.test(url)) {
    const rewritten = url.replace(/^https?:\/\/[^/]+\/api\//, `${window.location.origin}/_bf/api/`);
    return fetch(rewritten, init);
  }
  return fetch(input as any, init);
};

// Use environment variable - never hardcode credentials
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY || '';

export const insforge = createClient({
  baseUrl: window.location.origin,
  anonKey,
  fetch: sdkFetch,
});
