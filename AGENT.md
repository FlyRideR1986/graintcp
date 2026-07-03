# Agent Guide for `graintcp`

## Mission

Maintain a minimal Cloudflare Worker VLESS-over-WebSocket TCP relay with optional explicit HTTP CONNECT or SOCKS5 upstream proxy support.

The core architectural rule is:

```text
Clients decide routing policy.
The Worker relays traffic.
The Worker must not become a domain-routing engine by default.
```

This guide applies especially to the active `test` branch.

---

## Mandatory Working Method

### 1. Identify the actual target before changing anything

Before modifying code, confirm all three items:

```text
- Repository
- Branch
- Exact file path used for deployment
```

Do not assume a similarly named file is deployed. In this repository, `_worker.js`, `_worker.direct-fallback.js`, and other experimental entrypoints can have different behavior.

### 2. Fetch the target file from the requested branch

Use the GitHub connector to read the current content and capture the current blob SHA. Never edit against a remembered version.

### 3. Make the narrowest possible change

When a user asks to fix one behavior, modify only the code responsible for that behavior. Do not opportunistically refactor unrelated buffering, WebSocket, VLESS parsing, HTTP CONNECT, SOCKS5, or formatting logic.

### 4. Write directly to the requested file

For a normal source-file change, use the GitHub contents update action directly against the requested file and branch.

Do not use GitHub Actions as a patch transport, code generator, or indirect mutation mechanism unless the user explicitly asks for a workflow. Do not claim a change is complete until the target file itself has been read back and verified.

### 5. Verify after writing

Read the changed lines from the same branch after the update. Confirm:

```text
- New blob SHA differs from old blob SHA.
- Target code reflects the requested change.
- No temporary workflow or generated helper remains unless explicitly requested.
```

### 6. Report precisely

State:

```text
- File changed
- Branch changed
- Commit SHA
- Exact behavioral effect
- Important limitations
```

Never claim network behavior was validated unless actual end-to-end traffic testing occurred. Static review and syntax inspection are not traffic validation.

---

## System Model

### Entry point

The Worker accepts WebSocket upgrade requests and turns the VLESS header into a target host/port and initial payload.

The main connection flow is conceptually:

```text
WebSocket input
→ VLESS header parsing
→ getProxyCtx(request)
→ smartConnect(fetcher, targetHost, targetPort, ctx)
→ direct TCP or proxy tunnel
→ bidirectional byte relay
```

### Key functions

| Function | Responsibility |
|---|---|
| `getProxyCtx()` | Parse query/path proxy configuration into `globalProxy`, `proxyType`, and `parsedProxy`. |
| `smartConnect()` | Select fixed-global proxy, direct TCP, or direct-failure fallback. |
| `raceSprout()` | Open one or more direct outbound TCP sockets and resolve when one socket opens. |
| `httpConnect()` | Establish an HTTP CONNECT tunnel to the VLESS target. |
| `socks5Connect()` | Establish a SOCKS5 CONNECT tunnel to the VLESS target. |
| `ws()` | Own the VLESS/WebSocket session and byte forwarding lifecycle. |

Keep these responsibility boundaries clear.

---

## Routing Contract

### Intended precedence

```text
1. global proxy requested
   → use the selected proxy immediately

2. non-global proxy configured
   → try direct TCP first
   → only if direct TCP dial fails, use selected proxy

3. no proxy configured
   → direct TCP only
```

### Valid configuration syntax

#### Non-global fallback

```text
?socks5=USER:PASS@HOST:PORT
?http=USER:PASS@HOST:PORT

/s5=USER:PASS@HOST:PORT
/socks5=USER:PASS@HOST:PORT
/http=USER:PASS@HOST:PORT
```

Expected context:

```js
{
  globalProxy: false,
  proxyType: 'socks5' | 'http',
  parsedProxy: { username, password, hostname, port }
}
```

#### Forced global proxy

```text
?socks5=USER:PASS@HOST:PORT&globalproxy
?http=USER:PASS@HOST:PORT&globalproxy

/gs5=USER:PASS@HOST:PORT
/ghttp=USER:PASS@HOST:PORT

/socks5://USER:PASS@HOST:PORT
/socks://USER:PASS@HOST:PORT
/http://USER:PASS@HOST:PORT
```

Expected context:

```js
{
  globalProxy: true,
  proxyType: 'socks5' | 'http',
  parsedProxy: { username, password, hostname, port }
}
```

### Parser invariant

A configured non-global proxy must not be discarded merely because `globalproxy` is absent.

Correct final guard:

```js
if (!(proxyType && proxyAddress)) {
  return { globalProxy: false, proxyType: null, parsedProxy: {} };
}
return { globalProxy, proxyType, parsedProxy: parseProxyAddress(proxyAddress) };
```

Incorrect historical guard:

```js
if (!(globalProxy && proxyType && proxyAddress)) {
  return { globalProxy: false, proxyType: null, parsedProxy: {} };
}
```

The incorrect form silently prevents direct-first fallback because `smartConnect()` receives no proxy context.

---

## Connection Behavior and Limits

### Direct-first fallback is TCP-dial fallback only

The current logic makes a fallback decision based on whether a direct outbound socket reaches `socket.opened`.

```text
Direct socket fails before opened
→ fallback HTTP/SOCKS can run

Direct socket opens, then TLS/WSS/application traffic fails
→ no automatic route switch in current design
```

Do not call this full end-to-end failover. It does not identify whether encrypted TLS data represents success or failure.

### Why not retry blindly after first payload?

A TLS ClientHello or other protocol first payload is usually consumed when written to the direct socket. Replaying it after a later socket failure requires an explicit bounded replay buffer and a pre-response confirmation state machine.

Do not add such behavior casually. It changes memory, retransmission, and protocol semantics.

### Future experimental confirmation design

Develop in a separate experimental worker file only. Requirements:

```text
- Buffer a bounded amount of initial client payload.
- Do not commit the selected route until the first upstream byte arrives.
- If the candidate fails before any upstream data, close it and retry via fallback proxy.
- Replay the bounded initial payload exactly once.
- Once upstream data has been sent to the client, disable route switching.
- Add explicit limits: byte cap, timeout, retry count, and memory accounting.
```

---

## SOCKS5 Requirements

Maintain protocol-correct behavior.

### Target encoding

Encode the target using a SOCKS5 address type appropriate to the VLESS target:

```text
IPv4    → ATYP 0x01 + 4 bytes
Domain  → ATYP 0x03 + byte length + UTF-8 bytes
IPv6    → ATYP 0x04 + 16 bytes
```

Avoid converting raw target type into an ambiguous string and re-inferring it unless necessary.

### Reads

Do not assume one stream read equals one SOCKS5 protocol message.

Use exact-length reads for:

```text
- Method selection response
- Username/password response
- CONNECT response header
- Variable-length bound-address portion
```

### Credentials

- Split user/password at the first `:` only.
- Use UTF-8 byte lengths, not JavaScript character lengths.
- Enforce the protocol maximum of 255 bytes per username/password field.
- Query-string credentials must be URL encoded when they contain reserved characters such as `+`, `&`, or `#`.

---

## HTTP CONNECT Requirements

- Wait for `\r\n\r\n` before evaluating the HTTP response.
- Accept 2xx CONNECT responses, not only a hardcoded textual variant.
- Preserve bytes received after the CONNECT header. They can be tunnel payload and must not be discarded.
- Release reader/writer locks correctly.
- Do not expose proxy credentials in logs or error messages.

---

## Configuration and Security Rules

### UUID

`CFG.id` is intentionally empty in committed test entrypoints unless the user explicitly requests a repository-stored UUID. Deployments must set it correctly before use.

### Secrets

Never commit:

```text
- VLESS UUID used in production
- SOCKS/HTTP usernames or passwords
- Real proxy addresses that are not already public and explicitly requested
- Captured traffic payloads
```

### Logging

If adding diagnostics, log only low-sensitivity structured events such as:

```text
route=direct
route=socks5-fallback
route=http-global
stage=direct-open
stage=socks5-auth
stage=http-connect
```

Do not log full URLs, raw query strings, credentials, UUIDs, or payload bytes.

---

## Testing Checklist

### Static checks

Before committing:

```text
- Confirm changed syntax is valid JavaScript.
- Confirm the target path regex matches intended aliases.
- Confirm the parser returns proxy context for non-global routes.
- Confirm global forms set globalProxy=true.
- Confirm no unrelated source blocks changed.
```

### Functional matrix

Test all route forms separately:

| Mode | Required test |
|---|---|
| Direct only | No proxy configuration; direct target works. |
| Query SOCKS fallback | `?socks5=...`; direct-reachable target remains direct. |
| Query HTTP fallback | `?http=...`; direct failure uses HTTP CONNECT. |
| Query global SOCKS | `?socks5=...&globalproxy`; no direct attempt. |
| Query global HTTP | `?http=...&globalproxy`; no direct attempt. |
| Path SOCKS fallback | `/s5=...` and `/socks5=...`. |
| Path HTTP fallback | `/http=...`. |
| Path global SOCKS | `/gs5=...`. |
| Path global HTTP | `/ghttp=...`. |
| Legacy global paths | `/socks5://...`, `/socks://...`, `/http://...`. |

When testing fallback, distinguish:

```text
Direct dial failure
vs.
Direct dial success followed by remote/TLS/application failure
```

Only the former is currently guaranteed to trigger fallback.

---

## Change Discipline

### Do

- Preserve `globalproxy` as a deterministic manual override.
- Keep `smartConnect()` as the central route-selection point.
- Keep `getProxyCtx()` responsible for compatibility parsing.
- Add new behavior in a separate entrypoint when semantics are experimental.
- Directly update the exact requested source file.
- Read back the file after mutation.

### Do not

- Do not introduce Worker-side domain classification, geosite rules, or DNS routing by default.
- Do not replace direct update with a GitHub Actions workaround.
- Do not create wrapper entrypoints unless the user specifically asks for an alternate entrypoint.
- Do not silently alter existing URL syntax.
- Do not claim tests passed without real traffic validation.
- Do not mix protocol correctness changes and routing-policy changes in one unreviewed patch.

---

## Documentation Requirement

For material routing changes, update `DIRECT_FALLBACK_DEVELOPMENT_REPORT.md` with:

```text
- User-visible behavior
- Exact accepted syntax
- Root cause of any regression
- What was changed
- What remains intentionally unsupported
- Test evidence and its limits
```

The report and this guide should remain consistent with the currently deployed test-branch code.
