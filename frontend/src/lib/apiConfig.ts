const rawApiUrl = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

const getWsBaseUrl = (apiUrl: string): string => {
  const viteWsUrl = import.meta.env.VITE_WS_URL;
  if (viteWsUrl) return viteWsUrl.replace(/\/$/, '');
  if (apiUrl.startsWith('http')) {
    return apiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
  }
  // relative VITE_API_URL — derive WS base from window.location
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
};

export const API_BASE_URL = rawApiUrl;
export const WS_BASE_URL = getWsBaseUrl(rawApiUrl);
