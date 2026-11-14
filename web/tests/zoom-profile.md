Completed-response diff profile (2026-11-14)

Production Vite builds, headless Chromium 1243 with SwiftShader, 1280 × 800.
The baseline is commit `e7ffd08`; the comparison uses the completed-response diff
implementation. Both use `tests/data/geoflatpack-style.json`, including its SVG
symbols and collision settings. The fixture contains 180 multipart polygons with
holes, 180 vertex symbols sharing polygon gml IDs, and 180 multipart lines:
540 records and 127,620 positions. HTTP responses and the basemap are local,
deterministic fixtures. Backend code and README are unchanged.

After zooming in, each test sends nine outward wheel events and five inward
wheel events, 90 ms apart, then allows 500 ms to settle. Dynamic tests disable
Buffer to exercise replacements as the viewport expands. Static loading uses
the existing text-filter path to load the same complete fixture once and suppress
viewport requests. Initial source creation and loading are outside measurement.

The isolated runs measured:

| Measurement | Static before | Static after | Viewport before | Viewport after | BBox before | BBox after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sampled active main-thread CPU, ms | 84.332 | 69.033 | 1,149.699 | 667.541 | 875.802 | 446.570 |
| Collection requests / worker preparations | 0 | 0 | 24 | 33 | 34 | 26 |
| Dataset worker uploads | 0 | 0 | 48 full | 6 diffs | 68 full | 16 diffs |
| Dataset payload bytes | 0 | 0 | 114,419,875 | 999,960 | 91,113,488 | 1,492,140 |
| Dataset additions / removals / updates | — | — | — | 108 / 0 / 0 | — | 167 / 0 / 0 |
| Frame interval p95, ms | 16.8 | 16.7 | 16.8 | 16.7 | 16.7 | 33.4 |
| Largest frame interval, ms | 16.8 | 16.8 | 50.0 | 16.8 | 16.8 | 83.3 |
| Main-thread long tasks over 50 ms | 0 | 0 | 0 | 0 | 0 | 0 |
| Dataset filter changes sent to workers | 0 | 0 | 0 | 0 | 154 | 55 |
| Dataset tile reload messages | 0 | 0 | 272 | 15 | 746 | 210 |
| Reloads following filter changes | 0 | 0 | 0 | 0 | 746 | 152 |
| Dataset source / layer creations during zoom | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Main-thread CPU decreased about 42% for viewport zoom and 49% for BBox zoom;
dataset payload bytes decreased about 99.1% and 98.4%. Unchanged completed
snapshots no longer upload data. Different request counts reflect how the same
wheel interaction interacts with main-thread load and the existing request
coalescing; these are interaction totals, not equal-request microbenchmarks.

These single-run timings do **not** establish a consistent frame-rate improvement.
The isolated BBox p95 regressed to 33.4 ms with an 83.3 ms outlier. In the full
browser suite, viewport/BBox p95 were 33.3/16.7 ms instead. CPU and transfer
reductions are clear in these samples, while frame tails remain variable and
need further profiling on the target hardware and real dataset.

Worker preparation round-trip p50/p95 was 33.3/41.9 ms for viewport and 21.0/25.2 ms
for BBox. This includes message delivery, canonical identity/content preparation,
candidate spatial indexing/membership, and result delivery. It is not isolated
worker CPU time. The main-thread CPU profile attributed about 239 ms (viewport)
and 97 ms (BBox) to the instrumented Worker.postMessage call. Complete responses
still need decoding and cloning into the statistics worker, even when most
features are retained; this transfer is a remaining bottleneck. Canonical content
keys also allocate strings in the worker. BBox filter changes, their tile reloads,
and live outline work remain separate costs. Outline cost was not isolated here.

Uploads count MapLibre `LD` messages for dataset sources, excluding authorization,
BBox and buffer outlines. Payload size is the UTF-8 JSON size of the diff/full
payload, calculated **after** CPU/frame measurement to avoid adding serialization
work to the baseline. It approximates payload volume rather than structured-clone
wire bytes. `UL`/`SL` messages track source layer IDs and filter changes. A reload
is attributed to filters when its source has received a changed filter since its
last upload; this is a profiling heuristic, not a MapLibre causal trace. Frame
intervals come from requestAnimationFrame and long tasks from PerformanceObserver.
Active CPU excludes the profiler's idle/program samples and includes instrumentation.

`zoom.spec.ts` also inspects actual rendered frames around a held overlapping
response. Identical and reordered snapshots produce zero additional uploads;
the overlap sends exactly 90 additions and 180 removals across two existing
sources, and the sampled frames retain visible geometry. Final counts are checked
against exact geometry intersection. Existing browser regressions check BBox
pixel visibility, SVG appearance, layers, cancellation, empty results, failures,
user changes, reconnects, slow requests, continuous wheel requests, and panning.
Unit tests cover identity collisions/ambiguity, duplicate multiplicities, property
deletion, stale/failed acknowledgments, authorization clearing and continuous
camera movement. Retained worker geometry reuses its cached envelope, and retained
UI records are protected from MapLibre's mutations.

The renderer uses [MapLibre updateData](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/#updatedata)
with explicit numeric IDs. Ordinary responses send only add/remove/update diffs;
source hydration and failed-update recovery can send all acknowledged records
through updateData. Dataset setData is never used. A failed update does not advance
the applied snapshot. Whole-snapshot transactions serialize source updates, and
a pending complete response is coalesced to the latest snapshot. Camera counts
continue during uploads; candidate membership commits after acknowledgment, with
bounded camera refresh so continuous zoom cannot starve a snapshot commit.

Validation: TypeScript check, 254 unit tests, production build, and the complete
browser suite (54 passed, two optional live font/basemap checks skipped). The final
isolated zoom/frame regression run passed all four tests. The Vite build retains
its existing large-bundle advisory.

Reproduce from `web`:

```sh
npm run build
npm run test:e2e -- zoom.spec.ts
```

This machine uses
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/Users/tobiasnodland/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
For the full suite, `Fgb__Directory` points to
`Flatserve/bin/Debug/net10.0/test/fgb`, which contains the original fire-station
fixture expected by existing tests. A default Playwright installation needs no
executable override.

Each zoom profile writes `zoom-profile.json`, `zoom.cpuprofile`, and
`rendered-zoom.png` in its `test-results` directory. The overlap test writes
`retained-multipart.png`. The CPU profile opens in browser developer tools. For a
baseline, copy the three profiling tests and their unchanged fixture into a
checkout of `e7ffd08`, build that checkout, and set `ZOOM_BASELINE=1`; that flag
records measurements without enforcing diff-only assertions. The additional
retention test targets the new implementation and should be omitted for baseline
runs. Run comparisons sequentially to avoid contention.
