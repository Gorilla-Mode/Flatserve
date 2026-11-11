Panning profile (2026-11-11)

Production build, headless Chromium with SwiftShader, 1280 × 800 viewport. The
fixture contains 240 polygons with 513 positions each. Both versions used the
same 20-step horizontal drag with 60 ms pauses, inside existing buffered coverage.
The API and basemap responses were deterministic local fixtures.

| Measurement during drag | Previous viewport | Worker viewport | Previous BBox | Worker BBox |
| --- | ---: | ---: | ---: | ---: |
| Sampled active main-thread CPU (ms) | 175.191 | 57.902 | 214.067 | 72.213 |
| Dataset uploads to MapLibre workers | 0 | 0 | 3 | 0 |
| Full-feature JSON serializations | 21 | 0 | 21 | 0 |
| Collection requests | 0 | 0 | 0 | 0 |
| Bounds calculations dispatched to statistics worker | 0 | 18 | 0 | 19 |

CPU totals are single-run samples, excluding idle/program samples, and include
MapLibre rendering and browser work. They illustrate this fixture's improvement;
wall-clock timings vary. Dataset uploads measure MapLibre's `loadData` worker
messages, excluding authorization and BBox/buffer outline sources. Unit tests also
assert that unchanged batches, BBox membership changes, and visibility toggles do
not call dataset `setData()`.

The previous viewport happened to retain all 240 features throughout the drag,
so it made no uploads but still scanned and serialized all features on movement.
The worker version imports geometry intersection code only through its dedicated
worker entry point. Camera updates on the UI thread carry bounds and identifiers.

Reproduce after `npm run build` with `npm run test:e2e -- panning.spec.ts` in `web`.
The test saves `panning-profile.json` and `panning.cpuprofile` in its test-results
folder; the latter can be opened in browser developer tools. Set
`PANNING_BASELINE=1` when running the same fixture against the previous build to
record baseline values without enforcing the new worker assertions.

The complete browser suite expects the original 639-feature fire-station dataset.
For this checkout it was selected through `Fgb__Directory`, pointing to the local
`Flatserve/bin/Debug/net10.0/test/fgb` fixture directory. The installed Chromium was
selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Backend configuration and
dataset files were left unchanged. The two optional live basemap/font checks
were skipped; deterministic styling, SVG, geometry, authorization, counts,
reconnect, cancellation, and slow-request checks passed.
