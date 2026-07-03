# Direct Fallback Development Report

## Scope

This report records the development, debugging, verification, and corrective actions for the `test` branch implementation of explicit HTTP/SOCKS5 proxy handling and direct-first fallback behavior in the Cloudflare Worker VLESS relay.

The intended routing model is deliberately narrow:

```text
1. Explicit global proxy
   → force all target connections through the specified HTTP CONNECT or SOCKS5 proxy

2. Configured non-global proxy
   → attempt direct TCP connection first
   → use the configured HTTP CONNECT or SOCKS5 proxy only if the direct TCP dial fails

3. No proxy configuration
   → direct TCP only
```

The Worker remains a relay. Client-side software remains responsible for routing policy, domain rules, DNS policy, and deciding which Worker URL or path to use.

---

## Final Tested Behavior

### Query parameters

```text
?socks5=USER:PASS@HOST:PORT&globalproxy
?http=USER:PASS@HOST:PORT&globalproxy
```

Behavior: force all traffic through the selected proxy. No direct TCP attempt is made.

```text
?socks5=USER:PASS@HOST:PORT
?http=USER:PASS@HOST:PORT
```

Behavior: preserve proxy settings as fallback. The Worker first attempts direct TCP; if that dial fails, it switches to SOCKS5 or HTTP CONNECT.

### Path parameters

```text
/socks5=USER:PASS@HOST:PORT
/s5=USER:PASS@HOST:PORT
/http=USER:PASS@HOST:PORT
```

Behavior: same as non-global query parameters. Direct first, then proxy if direct TCP dialing fails.

```text
/gs5=USER:PASS@HOST:PORT
/ghttp=USER:PASS@HOST:PORT
```

Behavior: force global SOCKS5 or HTTP CONNECT proxy mode.

```text
/socks5://USER:PASS@HOST:PORT
/socks://USER:PASS@HOST:PORT
/http://USER:PASS@HOST:PORT
```

Behavior: force global proxy mode for backward compatibility.

---

## Timeline and Main Changes

### 1. Introduced explicit HTTP/SOCKS5 proxy modes

The first design added explicit proxy configuration to the Worker and routed connection creation through one strategy point:

```js
const smartConnect = (fetcher, host, port, ctx) =>
  ctx.globalProxy && ctx.proxyType === 'http' ? httpConnect(fetcher, host, port, ctx) :
  ctx.globalProxy && ctx.proxyType === 'socks5' ? socks5Connect(fetcher, host, port, ctx) :
  raceSprout(fetcher, host, port);
```

This correctly supported manual fixed-global operation, but initially offered no direct-first fallback path.

### 2. Corrected SOCKS5 protocol handling

The SOCKS5 implementation was strengthened before fallback work continued. The corrections included:

- Parse proxy credentials at the first `:` only, rather than splitting every colon.
- Encode IPv4, IPv6, and domain targets using appropriate SOCKS5 address types.
- Use exact-length reads for SOCKS5 negotiation and CONNECT replies.
- Consume the complete SOCKS5 bind-address reply instead of assuming one read maps to one protocol message.

These were protocol correctness fixes. They should not be conflated with route-selection behavior.

### 3. Added direct-first fallback logic

`smartConnect()` was changed to preserve fixed-global priority while using a configured proxy after direct dial failure:

```js
const smartConnect = async (fetcher, host, port, ctx) => {
  if (ctx.globalProxy && ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
  if (ctx.globalProxy && ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);

  try {
    return await raceSprout(fetcher, host, port);
  } catch (directError) {
    if (ctx.proxyType === 'http') return httpConnect(fetcher, host, port, ctx);
    if (ctx.proxyType === 'socks5') return socks5Connect(fetcher, host, port, ctx);
    throw directError;
  }
};
```

This is intentionally a TCP-dial fallback. `raceSprout()` resolves when the Cloudflare outbound socket opens. It does not prove that TLS, HTTP, WebSocket, or the remote application protocol will later succeed.

### 4. Found a configuration parsing regression

Testing showed that non-global fallback routes such as:

```text
/socks5=USER:PASS@HOST:PORT
```

were not switching to the proxy.

The root cause was not the fallback `catch` in `smartConnect()`. The root cause was `getProxyCtx()`.

The newer implementation only recognized the global aliases:

```js
/(gs5|ghttp)=(.+)/i
```

As a result, `/socks5=...`, `/s5=...`, and `/http=...` did not populate `proxyType` or `proxyAddress`. With no parsed proxy context, `smartConnect()` had nothing to use after direct connection failure.

### 5. Restored the legacy non-global path aliases

The direct fix was made directly in `_worker.direct-fallback.js`:

```js
} else if ((m = pathname.match(/\/(g?s5|socks5|g?http)=(.+)/i))) {
  const type = m[1].toLowerCase();
  proxyType = type.includes('http') ? 'http' : 'socks5';
  proxyAddress = m[2];
  globalProxy = type.startsWith('g') || globalProxy;
}
```

This restores the intended distinction:

```text
s5 / socks5 / http  → fallback-capable proxy context

gs5 / ghttp         → forced global proxy context
```

The user subsequently verified that the route forms worked.

---

## Root Causes

### Root cause 1: Confusing connection policy with parameter parsing

The fallback strategy was implemented correctly at the connection layer, but the parsing layer did not preserve a non-global proxy context for all supported path forms.

A connection fallback mechanism cannot work if `ctx.proxyType` and `ctx.parsedProxy` are absent.

### Root cause 2: Path syntax compatibility was narrowed unintentionally

The older working implementation accepted:

```text
/s5=...
/socks5=...
/http=...
/gs5=...
/ghttp=...
```

The new worker retained only:

```text
/gs5=...
/ghttp=...
```

That was an API compatibility regression, not an HTTP or SOCKS transport failure.

### Root cause 3: Incorrect use of a GitHub Actions workaround

An attempted one-time workflow-based patch did not modify the intended file and did not execute as expected. It also created unnecessary repository noise.

The corrective action was to stop using the workflow approach, remove it, and update the target file directly through the GitHub contents API. Repository changes must be verified by reading back the exact branch, file, and changed lines before reporting completion.

---

## What Worked

- Keeping `smartConnect()` as the central route-selection point was structurally correct.
- Preserving explicit `globalproxy` as the highest-priority mode was necessary for deterministic manual routing.
- Separating proxy protocol correctness work from fallback policy work reduced ambiguity.
- Direct read-back verification of `_worker.direct-fallback.js` after the final update confirmed the actual applied route parser.
- The final minimal patch changed only route parsing and left connection, buffering, SOCKS5, HTTP CONNECT, and VLESS relay behavior untouched.

---

## What Did Not Work

- Assuming that adding fallback logic to `smartConnect()` alone guaranteed working path-based fallback.
- Treating `/gs5=` and `/ghttp=` support as equivalent to legacy `/s5=`, `/socks5=`, and `/http=` support.
- Reporting a GitHub Actions-based mutation as complete before verifying that the target file actually changed.
- Creating an additional wrapper entrypoint before confirming whether the direct target-file patch had been applied. That added indirection without solving the actual parser regression.

---

## Important Technical Limitation

The present fallback logic has one deliberate boundary:

```text
Direct TCP dial fails before socket.opened
  → fallback can switch to SOCKS5 or HTTP CONNECT

Direct TCP socket opens, but TLS / WebSocket / remote application later fails
  → current fallback does not switch routes automatically
```

This boundary exists because a transparent TCP relay cannot reliably infer application success from encrypted payloads. Once the first client payload is sent on a direct socket, safely replaying it onto a new proxy connection requires a separate replay/confirmation state machine.

Do not describe the current implementation as automatic failover for all Cloudflare CDN, TLS, WSS, or application-layer failures. It is direct-dial fallback only.

---

## Recommended Test Matrix

Before merging future changes, test each mode with a known direct-reachable target and a known direct-unreachable target.

| Case | URL form | Expected result |
|---|---|---|
| Direct only | no proxy arguments | direct only; fails if direct dial fails |
| Query fallback SOCKS5 | `?socks5=...` | direct first; SOCKS5 only after direct dial failure |
| Query fallback HTTP | `?http=...` | direct first; HTTP CONNECT only after direct dial failure |
| Query forced SOCKS5 | `?socks5=...&globalproxy` | SOCKS5 only |
| Query forced HTTP | `?http=...&globalproxy` | HTTP CONNECT only |
| Path fallback SOCKS5 | `/s5=...` | direct first; SOCKS5 fallback |
| Path fallback SOCKS5 | `/socks5=...` | direct first; SOCKS5 fallback |
| Path fallback HTTP | `/http=...` | direct first; HTTP fallback |
| Path forced SOCKS5 | `/gs5=...` | SOCKS5 only |
| Path forced HTTP | `/ghttp=...` | HTTP CONNECT only |
| Legacy forced path | `/socks5://...` | SOCKS5 only |
| Legacy forced path | `/http://...` | HTTP CONNECT only |

For each test, validate both:

1. The desired traffic path actually succeeds.
2. The undesired traffic path is not being used when it should be bypassed.

---

## Future Development Direction

### Safe next steps

1. Add non-sensitive diagnostic mode.
   - Record selected route: `direct`, `socks5-global`, `http-global`, `socks5-fallback`, or `http-fallback`.
   - Record failure stage: direct socket open, proxy socket open, proxy authentication, CONNECT, or SOCKS CONNECT.
   - Never emit proxy credentials, full target payload, UUID, or unredacted user query strings.

2. Add automated parser tests.
   - Test `getProxyCtx()` with all query/path variants.
   - Assert both `proxyType` and `globalProxy`.
   - Include URL-encoded credentials and IPv6 proxy host cases.

3. Add protocol-level tests for SOCKS5 and HTTP CONNECT parsing.
   - Fragmented handshake replies.
   - Coalesced replies.
   - IPv4, IPv6, and domain target types.
   - Authentication and no-auth proxy modes.

4. Keep Worker routing policy intentionally small.
   - Do not add domain lists, geosite routing, DNS classification, or automatic target categorization inside this Worker unless the architecture changes explicitly.

### Higher-complexity future option: early-response route confirmation

Only pursue this if current direct-dial fallback is proven insufficient for the actual use case.

Required design elements:

```text
- Keep a bounded replay buffer for the initial client payload.
- Do not commit the route until the first upstream byte arrives.
- On pre-response EOF/error/timeout, close the candidate socket.
- Reconnect through fallback proxy.
- Replay the exact buffered bytes once.
- Once any upstream bytes are delivered to the client, disable failover for that session.
```

This is materially more complex and must have explicit bounds for replay data, retry count, timeout, and memory use. It should be developed as a separate experimental entrypoint, not silently added to the stable worker.

---

## Final Development Principles

```text
Configuration parsing determines whether fallback is even possible.

Route policy belongs in smartConnect; syntax compatibility belongs in getProxyCtx.

globalproxy must always remain an explicit force-proxy override.

A successful TCP socket open is not the same as an application-success signal.

Do not claim broader failover behavior than the implementation can verify.

For repository edits: directly mutate the intended file, read it back from the intended branch, then report success.
```
