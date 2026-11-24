# Flatserve
Prototype tool for hosting fgb files with server-side indexing and filtering support.

## Goal
The goal of this prototype is to provide spatial authorization and indexes on FBG attributes
so that clients can query for features in a given bounding box and with a given set of attributes.

## Build with Docker Compose

Run from the repository root:

```sh
docker compose build flatserve
```

This builds the image; it does not start the API.

## Multiple layers

Flatserve loads every `.fgb` in a folder at startup (top level only). Configure
the folder and indexed text attributes in `Flatserve/appsettings.json`, for example:

```json
{
  "Fgb": {
    "Directory": "test/fgb",
    "TextIndexes": ["type", "status"]
  }
}
```

## HTTP examples

These examples assume the API is running at `http://localhost:5220`. Responses are
binary and are saved to files by curl.

Get features within a bounding box around Kristiansand centre. Coordinates use
longitude (X) and latitude (Y) in degrees for the current dataset (EPSG:4326).
This bounding box returns no features from the tracked shooting-range dataset.
The required `zoom` parameter selects the level of detail; `12` requests the
full-detail layer.

```sh
curl --fail \
  "http://localhost:5220/fgb/collection?userId=2&minX=7.95&minY=58.10&maxX=8.08&maxY=58.20&zoom=12" \
  -H "Accept: multipart/mixed" \
  --dump-header collection.headers \
  --output collection.multipart
```

Get the feature at index `0` from the shooting-range layer:

```sh
curl --fail \
  "http://localhost:5220/fgb/Forurensning_0000_Norge_3035_Skytefelt_GML.SkyteOg_vingsfelt/feature/0" \
  -H "Accept: application/vnd.fgb" \
  --output feature-0.bin
```
The collection file is a multipart body; its boundary is recorded in
`collection.headers`. To download a single FGB directly, insert the layer ID
before `/collection` and use `Accept: application/vnd.fgb`.

*See also: [Flatserve.http](./Flatserve/test/http/Flatserve.http)*

## Logging and metrics

Configure the switches independently in `Flatserve/appsettings.json`:

```json
{
  "Logging": { "Enabled": true },
  "Metrics": { "Enabled": true }
}
```

## Generate metrics

With the API already running, ramp from 1,000 to 10,000 requests per second in
steps of 1,000, with 10 seconds per stage:

```sh
cd loadgen
go run . --duration 10 --rps 1000 --max-rps 10000 --step-rps 1000
```

The Go load test repeats a fixed route every 301 scheduled requests. It starts
at block level in central Bergen, zooms out to Breiviken, pans to Florø, and
returns to Bergen while zooming out to cover Vestland. Each ramp stage starts
at the Bergen block. Set `--duration` to at least 301 divided by `--rps`
seconds, using the starting rate for a ramp. This schedules at least one
loop per stage.

For the final bbox to return the full dataset, configure the API to serve
the Vestland-only FlatGeobuf file in EPSG:4326 with all features accessible
to user 2.

## Plot metrics

Run from the repository root to display the metrics chart and save it as `chart.png`:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install matplotlib
.venv/bin/python scripts/plot_metrics.py --output chart.png
```
