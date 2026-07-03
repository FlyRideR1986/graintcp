import worker from './_worker.direct-fallback.js';

const normalizeProxyPath = request => {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/(g?s5|socks5|g?http)=(.+)/i);
  if (!match) return request;

  const type = match[1].toLowerCase();
  const proxyType = type.includes('http') ? 'http' : 'socks5';
  url.pathname = '/';
  url.searchParams.set(proxyType, match[2]);
  if (type.startsWith('g')) url.searchParams.set('globalproxy', '');

  const patched = Object.create(request);
  Object.defineProperty(patched, 'url', { value: url.href });
  return patched;
};

export default {
  fetch: request => worker.fetch(normalizeProxyPath(request))
};
