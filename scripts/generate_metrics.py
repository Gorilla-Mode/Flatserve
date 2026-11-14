#!/usr/bin/env python3
"""Generate Flatserve metrics with Python 3.10+ and curl (no Python packages).

    python3 scripts/generate_metrics.py --duration 60 --rps 10
    python3 scripts/generate_metrics.py --duration 30 --rps 5 --yes

Start the API separately. The script prints a planned total and asks for y/N
confirmation unless --yes is given. Responses are discarded; the API writes its
usual metrics. --base-url defaults to http://localhost:5220.

Bounding boxes are approximately 150 x 150 km, centred randomly within 50 km of
mainland region anchors. They stay inside user 2's authorization rectangle.
These approximate county-sized boxes are not county boundaries or uniform
geographic sampling. All datasets are queried on each request.

Request starts are evenly scheduled, with at most 64 curl processes in flight.
Missed or capacity-limited slots are skipped, never sent in catch-up bursts.
After the duration, outstanding requests may take up to their ten-second timeout
to finish. Failures or skipped slots produce exit status 1; Ctrl+C produces 130.
"""

import argparse
import asyncio
from dataclasses import dataclass
import math
import os
import random
import shutil
import sys
import time
from urllib.parse import urlencode, urlsplit


BBOX_KM = 150
KM_PER_DEGREE = 111.32
MAX_IN_FLIGHT = 64
REQUEST_TIMEOUT = 10
# Approximate mainland region anchors, in longitude/latitude order.
ANCHORS = (
    (7.99, 58.15), (5.73, 58.97), (10.75, 59.91), (5.32, 60.39),
    (10.47, 61.12), (7.16, 62.74), (10.40, 63.43), (12.15, 65.84),
    (14.40, 67.28), (18.96, 69.65), (23.27, 69.97), (30.05, 69.73),
)


def random_bbox(rng=random) -> tuple[float, float, float, float]:
    longitude, latitude = rng.choice(ANCHORS)
    latitude += rng.uniform(-50, 50) / KM_PER_DEGREE
    half_height = BBOX_KM / (2 * KM_PER_DEGREE)
    latitude = min(max(latitude, 57.5 + half_height), 71.5 - half_height)
    km_per_longitude = KM_PER_DEGREE * math.cos(math.radians(latitude))
    longitude += rng.uniform(-50, 50) / km_per_longitude
    half_width = BBOX_KM / (2 * km_per_longitude)
    longitude = min(max(longitude, 4 + half_width), 32 - half_width)
    # Clamp the final arithmetic too, avoiding floating-point overshoot at the edges.
    return (max(4, longitude - half_width), max(57.5, latitude - half_height),
            min(32, longitude + half_width), min(71.5, latitude + half_height))


def request_url(base_url: str, rng=random) -> str:
    min_x, min_y, max_x, max_y = random_bbox(rng)
    query = urlencode({"userId": 2, "minX": f"{min_x:.8f}", "minY": f"{min_y:.8f}",
                       "maxX": f"{max_x:.8f}", "maxY": f"{max_y:.8f}"})
    return f"{base_url.rstrip('/')}/fgb/collection?{query}"


@dataclass
class Stats:
    planned: int
    attempted: int = 0
    successful: int = 0
    failed: int = 0
    skipped: int = 0
    first_error: str | None = None


async def send_request(curl: str, url: str, stats: Stats) -> None:
    stats.attempted += 1
    process = None
    success = False
    try:
        process = await asyncio.create_subprocess_exec(
            curl, "--disable", "--silent", "--show-error", "--output", os.devnull,
            "--write-out", "%{http_code}", "--max-time", str(REQUEST_TIMEOUT),
            "--header", "Accept: multipart/mixed", "--url", url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), REQUEST_TIMEOUT + 2)
        status = stdout.decode("ascii", errors="replace").strip()
        success = process.returncode == 0 and status.isdigit() and 200 <= int(status) < 300
        if success:
            stats.successful += 1
        elif stats.first_error is None:
            stats.first_error = f"curl exit {process.returncode}, HTTP {status}: " + stderr.decode(
                "utf-8", errors="replace").strip()[:300]
    except (OSError, asyncio.TimeoutError) as error:
        if stats.first_error is None:
            stats.first_error = str(error) or "Request timed out"
    finally:
        if not success:
            stats.failed += 1
        if process is not None and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.communicate()


async def run_load(curl: str, base_url: str, duration: float, rps: float, stats: Stats) -> None:
    pending = set()
    start = time.monotonic()
    interval = 1 / rps
    deadline = start + duration
    try:
        for index in range(stats.planned):
            slot = start + index * interval
            await asyncio.sleep(max(0, slot - time.monotonic()))
            now = time.monotonic()
            if now >= deadline:
                stats.skipped += stats.planned - index
                break
            if now >= slot + interval or len(pending) >= MAX_IN_FLIGHT:
                stats.skipped += 1
                continue
            task = asyncio.create_task(send_request(curl, request_url(base_url), stats))
            pending.add(task)
            task.add_done_callback(pending.discard)
        await asyncio.sleep(max(0, deadline - time.monotonic()))
        if pending:
            await asyncio.gather(*pending)
    finally:
        remaining = list(pending)
        for task in remaining:
            task.cancel()
        await asyncio.gather(*remaining, return_exceptions=True)


def positive_number(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a positive, finite number")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--duration", type=positive_number, required=True, help="request scheduling duration in seconds")
    parser.add_argument("--rps", type=positive_number, required=True, help="target requests per second")
    parser.add_argument("--base-url", default="http://localhost:5220", help="API base URL")
    parser.add_argument("--yes", action="store_true", help="skip confirmation")
    args = parser.parse_args()
    total = args.duration * args.rps
    if not math.isfinite(total) or total < 1:
        parser.error("duration multiplied by rps must be finite and at least 1")
    parsed = urlsplit(args.base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment:
        parser.error("--base-url must be an HTTP(S) URL without a query or fragment")
    curl = shutil.which("curl")
    if curl is None:
        parser.error("curl is required; install it and ensure it is on PATH")
    stats = Stats(math.floor(total))
    print(f"Endpoint: {args.base_url.rstrip('/')}/fgb/collection (user 2, all datasets)")
    print(f"Duration: {args.duration:g} s | Target: {args.rps:g} requests/s | Planned total: {stats.planned}")
    print(f"Random Norway bounding boxes: approximately {BBOX_KM} x {BBOX_KM} km")
    try:
        if not args.yes and input("Start? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Cancelled; no requests sent.")
            return 0
    except EOFError:
        print("\nCancelled; no confirmation received.")
        return 0
    except KeyboardInterrupt:
        print("\nCancelled; no requests sent.")
        return 130
    started = time.monotonic()
    interrupted = False
    try:
        asyncio.run(run_load(curl, args.base_url, args.duration, args.rps, stats))
    except KeyboardInterrupt:
        interrupted = True
        print("\nInterrupted; outstanding requests stopped (counted as failed).")
    print(f"Planned: {stats.planned} | Attempted: {stats.attempted} | Successful: {stats.successful} | "
          f"Failed: {stats.failed} | Skipped: {stats.skipped} | Elapsed: {time.monotonic() - started:.2f} s")
    if stats.first_error:
        print(f"First failure: {stats.first_error}", file=sys.stderr)
    return 130 if interrupted else int(stats.failed > 0 or stats.skipped > 0)


if __name__ == "__main__":
    sys.exit(main())
