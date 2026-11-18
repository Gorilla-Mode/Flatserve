Worker decoding profile (2026-11-15)

The comparison uses production Vite builds of baseline `b12993b` and the worker
implementation, run sequentially in headless Chromium 1243 with SwiftShader at
1280 × 800. Both run `browser/decode-profile.spec.ts` with the same deterministic
multipart fixture: 50,000 points, two layers, 7,120,683 binary bytes, Unicode and
text properties. Empty discovery and initial viewport responses finish before
measurement; one filter activation loads the complete fixture. The basemap is a
local empty style and dataset layers use the existing basic styling.

| Measurement | Baseline | Worker decoding |
| --- | ---: | ---: |
| Sampled active main-thread CPU, ms | 266.828 | 122.329 |
| Main-thread tasks over 50 ms | 1 (157 ms) | 0 |
| Worker decoding and aggregation wall time, ms | — (decoded on main thread) | 177.0 |
| Decode message round trip, ms | — | 177.1 |
| Request-to-display acknowledgment, ms | 611.8 | 625.6 |
| Complete decoded feature arrays sent to statistics worker | 1 | 0 |
| Binary buffers transferred / detached | 0 / 0 | 1 / 1 |
| Snapshot preparations | 1 | 1 |

These are individual observations, not a speedup guarantee. Main-thread CPU was
lower and the measured long task disappeared; display latency was slightly
higher in this sample. Initial additions still need to return to the main thread
as snapshot diffs and upload to MapLibre. The change removes main-thread decoding
and the subsequent full decoded-array clone into the statistics worker.

Worker time includes multipart parsing, decoding, layer tagging, feature
aggregation, and cooperative scheduling delays. It excludes snapshot diffing,
spatial indexing and rendering. Request timings use absolute timestamps derived
from each context's performance.timeOrigin and are emitted before preparation.
The display metric runs from filter fetch initiation to the committed status
update after source upload acknowledgment; it is not a GPU presentation timestamp.
Two animation frames settle before profiling ends. CPU excludes profiler
idle/program/root samples and includes instrumentation, UI work and rendering.
The fixture is small enough for the original implementation to complete; a
separate regression publishes 250,000 features, including one 150,000-feature
multipart layer, through split session responses.

The initial implementation yielded through a timer at every batch, including
short aggregation loops. An exploratory run measured 906.1 ms worker decoding
and 1429.8 ms display acknowledgment. The final implementation checks an 8 ms
work budget before yielding, avoiding repeated clamped timers while still
allowing cancellation and camera queries between bounded batches.

Validation: TypeScript checks, 269 frontend unit tests, production build, and
55 browser tests passed; the two optional live font/basemap checks were skipped.
Tests cover transferred-buffer detachment, metadata-only discovery and release,
empty/malformed layers, cancellation, stale request/connection IDs, superseded
handles, renderer readiness/replacement, authorization changes, failed uploads,
and retained snapshot publication. The build retains its existing large-chunk
advisory. No backend, dependency, stylesheet or wire-format changes were needed.

Reproduce from `web`:

```sh
npm run build
npm run test:e2e -- decode-profile.spec.ts
```

Each run writes `decode-profile.json` and `decode.cpuprofile` in its Playwright
`test-results` directory. The latter opens in browser developer tools. For the
baseline, copy the profiling test into an archive/checkout of `b12993b`, use the
same dependencies, build it, and set `DECODE_BASELINE=1`. That flag records the
original array handoff without enforcing the new transfer assertions. Run builds
sequentially on separate preview ports to avoid contention or reusing the wrong
preview server. The profile itself mocks all API calls and needs no dataset.

The full browser suite expects the original fire-station fixture. This run
restored it from commit `94c3ff2` into `/private/tmp/flatserve-fire-fixture/dataset.fgb`
and set `Fgb__Directory` to that directory, keeping repository datasets unchanged.
Using the ID `dataset` preserves the original basic red styling in pixel checks.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selected the installed Chromium headless
shell; a standard Playwright installation needs no override.
