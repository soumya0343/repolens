const rawApiUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

const normalizeWsProtocol = (url: string) => {
  if (url.startsWith('https')) {
    return url.replace(/^https/, 'wss');
  }
  return url.replace(/^http/, 'ws');
};

export const API_BASE_URL = rawApiUrl;
export const WS_BASE_URL = import.meta.env.VITE_WS_URL ?? normalizeWsProtocol(rawApiUrl);
