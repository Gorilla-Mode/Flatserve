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

## HTTP examples

These examples assume the API is running at `http://localhost:5220`. Responses are
binary and are saved to files by curl.

Get features within a bounding box around Kristiansand centre. Coordinates use
longitude (X) and latitude (Y) in degrees for the current dataset (EPSG:4326):

```sh
curl --fail \
  "http://localhost:5220/fgb/collection?minX=7.95&minY=58.10&maxX=8.08&maxY=58.20" \
  -H "Accept: application/octet-stream" \
  --output collection.bin
```

Get the feature at index `0`:

```sh
curl --fail \
  "http://localhost:5220/fgb/feature/0" \
  -H "Accept: application/octet-stream" \
  --output feature-0.bin
```
*See also: [Flatserve.http](./Flatserve/test/http/Flatserve.http)*