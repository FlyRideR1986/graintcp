#!/usr/bin/env node
/**
 * Generates a deployable candidate worker without changing _worker.js.
 *
 * Usage:
 *   node make_direct_fallback_worker.js [source] [target]
 *
 * Defaults:
 *   source: _worker.js
 *   target: _worker.direct-fallback.js
 */

import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.argv[2] || '_worker.js';
const targetPath = process.argv[3] || '_worker.direct-fallback.js';

const oldSmartConnect = `const smartConnect = (fetcher, host, port, ctx) =>
  ctx.globalProxy && ctx.proxyType === 'http' ? httpConnect(fetcher, host, port, ctx) :
  ctx.globalProxy && ctx.proxyType === 'socks5' ? socks5Connect(fetcher, host, port, ctx) :
  raceSprout(fetcher, host, port);`;

const newSmartConnect = `const smartConnect = async (fetcher, host, port, ctx) => {
  // Explicit global mode always wins: do not expose a direct-connection attempt.
  if (ctx.globalProxy && ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
  if (ctx.globalProxy && ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);

  try {
    return await raceSprout(fetcher, host, port);
  } catch (directError) {
    // A configured non-global proxy is a fallback only after every direct attempt fails.
    if (ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
    if (ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);
    throw directError;
  }
};`;

const oldGetProxyCtxTail = `  if (!(globalProxy && proxyType && proxyAddress)) return { globalProxy: false, proxyType: null, parsedProxy: {} };
  try { return { globalProxy: true, proxyType, parsedProxy: parseProxyAddress(proxyAddress) }; }
  catch { return { globalProxy: false, proxyType: null, parsedProxy: {} }; }`;

const newGetProxyCtxTail = `  // Keep a valid proxy configuration even without globalproxy: smartConnect() will use it as fallback.
  if (!(proxyType && proxyAddress)) return { globalProxy: false, proxyType: null, parsedProxy: {} };
  try { return { globalProxy, proxyType, parsedProxy: parseProxyAddress(proxyAddress) }; }
  catch { return { globalProxy: false, proxyType: null, parsedProxy: {} }; }`;

const source = await readFile(sourcePath, 'utf8');
if (!source.includes(oldSmartConnect)) {
  throw new Error(`smartConnect source block not found in ${sourcePath}; aborting without writing output.`);
}
if (!source.includes(oldGetProxyCtxTail)) {
  throw new Error(`getProxyCtx source block not found in ${sourcePath}; aborting without writing output.`);
}

const updated = source
  .replace(oldSmartConnect, newSmartConnect)
  .replace(oldGetProxyCtxTail, newGetProxyCtxTail);

await writeFile(targetPath, updated, 'utf8');
console.log(`Created ${targetPath}`);
