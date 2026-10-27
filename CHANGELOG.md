# Changelog

## 0.2.0 - 2026-10-27

- Every script-bearing call travels hash-first. `akamai.sensor`, `akamai.sbsd`,
  `kasada.sensor`, `kasada.cd`, `incapsula.reese84` and `incapsula.utmvc` send
  the script's SHA-256 as `script_id` and no script; the API keeps every
  script it has been sent, so the body is uploaded only when nobody has sent
  that script yet (409 `script_cache_miss`, not billed), in one automatic
  resend. An Akamai sensor request goes from hundreds of KB to about 1 KB on
  the wire, a Kasada one from about 700 KB. After a miss the client sends the
  script directly for a minute, so a burst of solves for a new script uploads
  it once. `scriptId()` computes the digest; `akamaiScriptId()` remains.
- Kasada and Incapsula requests accept `script_id` instead of `script`, and
  every script-bearing response returns `script_id`.
- Every solve returns `client_hints`, the UA client hints of the device the
  payload describes. Send `sec-ch-ua`, `sec-ch-ua-mobile` and
  `sec-ch-ua-platform` on every request, and the others only to sites whose
  `Accept-CH` header asks for them.
- Akamai: `telemetry: true` on `akamai.sensor` returns the `Akamai-BM-Telemetry`
  header value in the result's `telemetry`, for sites that protect
  their API calls with that header instead of a sensor post.
  the result's `paced_ms` reports how long a paced response was held.
- A script the API could never accept (over 1 MiB encoded) is refused locally
  as a `ValidationError` on `script` before any round trip.
- PerimeterX: `perimeterx.init` and `perimeterx.solveHold` results carry
  `accept_language`, the Accept-Language the session runs as. Without
  `accept_language` in the request the API draws a real Chrome value for the
  proxy exit's country; the SDK keeps your own value when you set one. Send
  every request of the session with `ua` and `accept_language`.
- PerimeterX: `platform: "auto"` on `perimeterx.init` has the solver draw
  each session's platform (Windows or macOS) and, without `ua`, a current
  Chrome major; the response's new `platform` field reports the draw.
- Akamai: `pace` on `akamai.sensor` asks the API to hold each response
  until a person's interval (2.5-4 s) has passed since the previous sensor.

## 0.1.0 - 2026-10-05

First release of the Node.js / TypeScript SDK, licensed under the MIT License.

- `BypassFast` client (also exported as `Client`) with `akamai.sensor`,
  `akamai.sbsd`, `akamai.cpt`, `akamai.secCpt`, `kasada.sensor`, `kasada.cd`,
  `incapsula.reese84`, `incapsula.utmvc`, `perimeterx.init`,
  `perimeterx.solveHold`, `balance()` and the generic `solve(solver, body)`.
- Request and response types use the API's snake_case field names. Every
  result carries a non-enumerable `response` with status, request ID, edge,
  Server-Timing and attempt count.
- Akamai sensor scripts are sent once and then referenced by `script_id`;
  Incapsula scripts are referenced by their URL. Both resend the full script
  automatically on `script_cache_miss` or `script_cache_unavailable`.
- Automatic retries for explicit, retryable API errors with full-jitter
  backoff, `retry_after_ms` / `Retry-After` hints, and a time budget for
  `429 solver_busy`. Transport failures are never retried.
- Cancellation with `AbortSignal` and per-call deadlines; per-attempt timeouts
  of 65 s (155 s for PerimeterX).
- Gzip request compression, 1 MiB request limit (2 MiB for PerimeterX),
  4 MiB response limit, redirects never followed.
- No runtime dependencies; ES module and CommonJS builds with type
  declarations; Node.js 18.17 or newer.
