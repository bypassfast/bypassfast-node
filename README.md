# Bypass Fast Node.js SDK

The official TypeScript client for the [Bypass Fast](https://bypass.fast) API:
Akamai Bot Manager, Kasada, Imperva / Incapsula and PerimeterX / HUMAN
solvers. It has no runtime dependencies, ships ES module and CommonJS builds
with type declarations, and runs on Node.js 18.17 or newer.

```sh
npm install bypassfast
```

Full API reference: <https://bypass.fast/docs>.

The SDK calls the Bypass Fast API only. Your own HTTP client still fetches the
target pages and scripts and submits the generated artifacts, through the proxy
and with the user agent the target session uses.

## Quick start

```ts
import { BypassFast } from "bypassfast";

const client = new BypassFast(process.env.BYPASS_FAST_API_KEY!);

const result = await client.kasada.sensor({
  script: pJsText, // the raw p.js body, not base64
  ua: "<target-session Chrome user agent>",
  url: "https://www.example.com/checkout",
});

// Submit result.payload with every result.headers entry to Kasada, then send
// the protected request with result.user_agent verbatim.
```

CommonJS works the same way: `const { BypassFast } = require("bypassfast");`.

Create one client and reuse it. It holds the script memory that lets repeated
Akamai and Incapsula scripts travel as a hash instead of the full body.

Request objects use the API's snake_case field names, so a JSON body from the
docs pastes straight in. Every method takes `(request, options?)` and returns a
promise.

## Solvers

| Protection | Method | Returns |
| --- | --- | --- |
| Akamai Bot Manager | `client.akamai.sensor` | `sensor_data`, `session`, exact `ua` and `language`, `script_id` |
| Akamai SBSD | `client.akamai.sbsd` | encrypted SBSD `body`, `session`, `script_id` |
| Akamai Sec-CPT | `client.akamai.cpt` | proof `answers` |
| Akamai sec-cpt challenge page | `client.akamai.secCpt` | `answers` and the exact `/_sec/verify` `body` |
| Kasada sensor | `client.kasada.sensor` | encrypted `payload`, `x-kpsdk-*` `headers`, `user_agent` |
| Kasada CD | `client.kasada.cd` | `payload` for `x-kpsdk-cd` |
| Incapsula Reese84 | `client.incapsula.reese84` | sensor `payload`, device `session` |
| Incapsula UTMVC | `client.incapsula.utmvc` | `___utmvc` `cookie` and `submit_path` |
| PerimeterX init | `client.perimeterx.init` | HUMAN `cookies` and an opaque `session` |
| PerimeterX hold | `client.perimeterx.solveHold` | `success`, refreshed `cookies`, retry advice |

`client.balance()` reads the prepaid balance. `client.solve(solver, body)`
posts a raw body to `/v1/solve/{solver}`; use it for fields this SDK version
does not model yet.

### Akamai

```ts
const sensor = await client.akamai.sensor({
  url: "https://www.example.com/checkout",
  ua: userAgent,
  abck: "0~-1~-1~-1~-1", // current _abck cookie
  bm_sz: bmSzCookie,
  script: scriptBytes, // raw Uint8Array (or string); the SDK base64-encodes it
  script_url: "https://www.example.com/_bm/abc.js",
});
// POST {"sensor_data": sensor.sensor_data} to the sensor endpoint (usually
// script_url) with sensor.ua, then keep sensor.session for the next sensor
// call of the same flow.
```

After a script succeeds, the client remembers its SHA-256 and later fresh
sessions send only `script_id`. If the server-side entry has expired
(`409 script_cache_miss`) or the cache is unavailable, the client resends the
script once automatically; `result.response.attempts` counts both requests.
In a new process, pass both `script_id` (saved from an earlier response, or
`akamaiScriptId(scriptBytes)`) and `script` to try the compact form first.
Calls with a `session` send neither field.

SBSD follows the same pattern: keep the `session` the first response returns
and send it, with `script_id` in place of `script`, on every later post for
that page.

### Kasada

```ts
const sensor = await client.kasada.sensor({ script: pJsText, ua: userAgent, url: pageUrl });
const cd = await client.kasada.cd({
  script: pJsText, st, ct, domain, work_time, rst, d, id, duration, fc, // from the CD challenge
});
// Send cd.payload as the x-kpsdk-cd header.
```

`seed` accepts a `bigint`, a safe-integer `number` or a decimal string and is
sent as a JSON number, so the full unsigned 64-bit range survives.

### Incapsula

```ts
const reese = await client.incapsula.reese84({
  url: "https://www.example.com/checkout",
  script_url: loaderUrl, // absolute URL the script was fetched from
  ua: userAgent,
  script: loaderJs,
  document_html: challengedPageHtml,
});
// POST reese.payload verbatim to the sensor endpoint; pass reese.session on
// the next solve of the same browser session.
```

The client remembers the SHA-256 for each mode and full `script_url`. An
identical script at the same URL is sent as the URL alone; changed bytes are
sent in full; a remote cache miss falls back to the full script automatically.

### PerimeterX / HUMAN

```ts
const init = await client.perimeterx.init({
  url: "https://www.example.com/en/booking",
  proxy: "http://user:pass@proxy.example.net:8000",
});
// Set every init.cookies entry and send your requests through the same proxy
// with init.ua. If one comes back as a HUMAN block:
const hold = await client.perimeterx.solveHold({
  session: init.session,
  proxy: "http://user:pass@proxy.example.net:8000",
  blocked: { url: blockedUrl, method: "POST", status: 428, headers: blockedHeaders, body: blockedBody },
});
if (hold.rejected) {
  // Stop: a rejected hold is not an error, and it is billed.
}
```

`success: false` is a 2xx response, not an exception. `hold.rejected` and
`hold.changeExit` are convenience getters. Set `blocked.body_encoding: "base64"`
(or `body_base64: true`) for bodies that are not valid text. PerimeterX
requests may be up to 2 MiB and use a 155 s per-attempt timeout by default.

## Results

Every result is the API's JSON object plus a non-enumerable `response`
property:

```ts
result.response; // { statusCode, requestId, edge, serverTiming, attempts }
```

Quote `requestId` to support. Because `response` is non-enumerable,
`JSON.stringify(result)` reproduces the API body.

## Errors and retries

```ts
import { APIError, isErrorCode } from "bypassfast";

try {
  await client.kasada.cd(request);
} catch (error) {
  if (isErrorCode(error, "quota_exceeded")) {
    // top up
  } else if (error instanceof APIError) {
    console.error(error.code, error.response.statusCode, error.response.requestId);
  }
}
```

| Error | When |
| --- | --- |
| `ValidationError` | Rejected locally before any request: bad options, missing required fields, a body over the size limit. `field` names the input. |
| `RequestError` | No response: network failure or the per-attempt timeout. Never retried, because the solve may have completed. |
| `ResponseError` | The response could not be read: unsupported encoding, over 4 MiB, or a 2xx body that is not a JSON object. |
| `APIError` | Any non-2xx response, a 3xx included. `code` is the stable machine code; `stage`, `reason`, `retryAfterMs` and `retryable` refine it. |

All four extend `BypassFastError`. Error messages never include response bodies
or the API's human-readable message, which can echo request inputs; read it
from `error.apiMessage` when you need it.

Retries apply only to explicit API responses that are safe to repeat. By
default the client retries up to twice with full-jitter exponential backoff
(500 ms base, 8 s cap) and waits at least the server's hint
(`retry_after_ms`, else `Retry-After`). `internal` and `internal_error` are
retried at most once. `proxy_error`, `quota_exceeded` and the other permanent
codes are never retried.

`429 solver_busy` is retried against a time budget instead of `maxRetries`:
for up to 45 s from the start of the call by default. Each wait is at least
the server's hint plus jitter whose window doubles per retry (capped at 10 s
and kept inside the budget). Set `solverBusyRetryBudgetMs: 0`, or
`retry.maxRetries: 0`, to turn it off. Retries smooth a burst but do not add
capacity, so bound your own concurrency.

## Cancellation

```ts
const controller = new AbortController();
await client.akamai.sensor(request, { signal: controller.signal });
await client.kasada.cd(request, { deadline: Date.now() + 30_000 });
```

`signal` aborts an in-flight request or a backoff wait; the promise rejects
with `signal.reason`. `deadline` (a `Date` or epoch milliseconds) bounds the
whole call, retries included, and rejects with a `TimeoutError`; a
`solver_busy` retry that could not start before it is skipped and the
`solver_busy` error is returned instead.

## Configuration

```ts
const client = new BypassFast(apiKey, {
  baseUrl: "https://api.bypass.fast",
  timeoutMs: 65_000,
  perimeterxTimeoutMs: 155_000,
  retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8_000 },
  solverBusyRetryBudgetMs: 45_000,
  compressionThreshold: 1024,
  userAgent: "checkout-service/2.4.0",
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `https://api.bypass.fast` | HTTPS required unless the host is loopback. |
| `timeoutMs` | `65000` | Per attempt: connect, headers and body. |
| `perimeterxTimeoutMs` | `155000` | Per attempt, PerimeterX only. |
| `retry.maxRetries` | `2` | 0 to 10. 0 disables every automatic retry. |
| `retry.baseDelayMs`, `retry.maxDelayMs` | `500`, `8000` | Backoff ceiling and cap. Unset fields keep their defaults. |
| `solverBusyRetryBudgetMs` | `45000` | 0 to one hour; 0 disables `solver_busy` retries. |
| `compressionThreshold` | `1024` | Bodies of at least this many bytes are gzipped when that saves bytes. Negative disables; 0 compresses every body. |
| `userAgent` | none | Appended to `bypassfast-node/<version>`. |
| `fetch` | global `fetch` | Inject a `fetch`-compatible function, for example in tests. |

## Transport

- Request bodies are fully buffered so `Content-Length` is always sent.
- Bodies are rejected locally above the API limit: 1 MiB of encoded JSON, or
  2 MiB for PerimeterX.
- Responses are limited to 4 MiB after gzip decoding.
- Redirects are never followed, so `X-API-Key` cannot reach another origin.

Never log request objects or results: they can contain API keys, proxy
credentials, device sessions, target cookies and challenge tokens.

## Pricing

Billed per successful (2xx) solve; see <https://bypass.fast/pricing>.

## License

MIT. See [LICENSE](LICENSE).
