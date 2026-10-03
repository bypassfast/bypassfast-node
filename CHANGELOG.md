# Changelog

## 0.1.0

First release of the Node.js / TypeScript SDK.

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
