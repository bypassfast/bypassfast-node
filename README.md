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
| Akamai Bot Manager | `client.akamai.sensor` | `sensor_data`, `session`, exact `ua` and `language`, `script_id`, `client_hints`, optional `telemetry` |
| Akamai SBSD | `client.akamai.sbsd` | encrypted SBSD `body`, `session`, `script_id`, `client_hints` |
| Akamai Sec-CPT | `client.akamai.cpt` | proof `answers` |
| Akamai sec-cpt challenge page | `client.akamai.secCpt` | `answers` and the exact `/_sec/verify` `body` |
| Kasada sensor | `client.kasada.sensor` | encrypted `payload`, `x-kpsdk-*` `headers`, `user_agent`, `client_hints`, `script_id` |
| Kasada CD | `client.kasada.cd` | `payload` for `x-kpsdk-cd`, `script_id` |
| Incapsula Reese84 | `client.incapsula.reese84` | sensor `payload`, device `session`, `script_id`, `client_hints` |
| Incapsula UTMVC | `client.incapsula.utmvc` | `___utmvc` `cookie` and `submit_path`, `script_id` |
| PerimeterX init | `client.perimeterx.init` | HUMAN `cookies`, an opaque `session`, `client_hints` |
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

The script travels as its SHA-256 and is uploaded once, only when the API has
never seen it ([Script handling](#script-handling)); `result.response.attempts`
counts both requests when that happens. Calls with a `session` send neither
field. For sites that protect their API calls with an `Akamai-BM-Telemetry`
header instead of a sensor post, pass `telemetry: true` and the result
carries the ready-to-send header value in `telemetry`.

A page posts its sensors seconds apart, and protected endpoints score a
session whose sensors arrive a fraction of a second apart. Either wait
2.5-4 s between the sensor calls of one session, or pass `pace: true` on
them: the API then holds each continuation response until that interval
has passed (never more than 6 s, never the first call), and the call simply
takes longer.

SBSD follows the same pattern: keep the `session` the first response returns
and send it, with `script_id` in place of `script`, on every later post for
that page.

A normal `200` page can run SBSD too: a first-party script whose URL carries
`?v=` sits next to the sensor script, and the page response sets `bm_so`. Post
it as part of the page, before any protected request: after the first sensor
post, call `client.akamai.sbsd` with the sensor's `session` and `sbsd_o` set to
the `bm_so` value, POST `{"body": ...}` to the script path without its query,
continue the sensor with the `session` it returned, then, after the page's
third sensor post, ask for the two telemetry posts with
`sbsd_post: "telemetry"` (wait `wait_ms`, or pass `pace: true`). A refused
telemetry call is a 409 whose `APIError.reason` says what to do: `no_input`
means post the page's next sensor and ask again (waiting alone never makes it
due), `complete` means send no more. The full order is on the
[SBSD docs page](https://bypass.fast/docs/solvers/akamai/sbsd#inline-sbsd-on-a-normal-page).
A client that skips it still gets a valid `_abck`, and the protected endpoint
answers `403` instead.

### Kasada

```ts
const sensor = await client.kasada.sensor({ script: pJsText, ua: userAgent, url: pageUrl });
const cd = await client.kasada.cd({
  script: pJsText, st, ct, domain, work_time, rst, d, id, duration, fc, // from the CD challenge
});
// Send cd.payload as the x-kpsdk-cd header.
```

`seed` accepts a `bigint`, a safe-integer `number` or a decimal string and is
sent as a JSON number, so the full unsigned 64-bit range survives. The `p.js`
source travels as its SHA-256 and is uploaded once, only when the API has
never seen it ([Script handling](#script-handling)).

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

The loader travels as its SHA-256 and is uploaded once, only when the API has
never seen it ([Script handling](#script-handling)); `script_url` still
identifies the loader family.

### Script handling

Every script-bearing call (`akamai.sensor`, `akamai.sbsd`, `kasada.sensor`,
`kasada.cd`, `incapsula.reese84`, `incapsula.utmvc`) travels hash-first: the
request carries the script's SHA-256 as `script_id` and no script. The API
keeps every script it has been sent for days, so the body is only needed when
nobody has sent that script yet; the API then answers `409 script_cache_miss`
(not billed) and the SDK repeats the call once with the script. A new script
version costs one extra round trip, once, fleet-wide: an Akamai sensor
request is about 1 KB on the wire instead of hundreds of KB, a Kasada one
about 1 KB instead of 700 KB. After a miss the client sends the script
directly for a minute, so a burst of solves for a brand-new script uploads
it once; `503 script_cache_unavailable` is retried first.

Keep passing the script exactly as today. When it is not at hand, pass
`script_id` instead (every script-bearing response returns it, and
`scriptId(raw)` computes it); a cache miss is then thrown as the `APIError`.
A script the API could never accept (over 1 MiB encoded) is refused locally
as a `ValidationError` before any round trip.

### Client hints

Every solve returns `client_hints`: the UA client hints of the device the
payload describes, as Chrome sends them. Send `sec-ch-ua`, `sec-ch-ua-mobile`
and `sec-ch-ua-platform` on every request of the session, and the other
hints (`sec-ch-ua-platform-version`, `sec-ch-ua-full-version-list`, ...)
only to sites whose `Accept-CH` response header asks for them.

### PerimeterX / HUMAN

```ts
const init = await client.perimeterx.init({
  url: "https://www.example.com/en/booking",
  proxy: "http://user:pass@proxy.example.net:8000",
});
// Set every init.cookies entry and send your requests through the same proxy
// with init.ua and init.accept_language (drawn for the exit's country when you
// set none). If one comes back as a HUMAN block, send it with the cookies you
// hold for the site at that point (HUMAN's included):
const hold = await client.perimeterx.solveHold({
  session: init.session,
  proxy: "http://user:pass@proxy.example.net:8000",
  blocked: { url: blockedUrl, method: "POST", status: 428, headers: blockedHeaders, body: blockedBody },
  cookies: cookiesHeldAtTheBlock,
});
if (hold.rejected) {
  // Stop: a rejected hold is not an error, and it is billed.
}
```

`platform: "auto"` on `init` lets the API draw each session's platform
(Windows or macOS) and Chrome version; `init.platform` and `init.ua` report
the draw. Send `auto` only through exits that suit both Windows and macOS
clients.

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
