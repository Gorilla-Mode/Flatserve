#!/usr/bin/env python3
"""Plot Flatserve's JSON-lines metrics (Python 3.10+ and Matplotlib).

Install and run from the repository root::

    python3 -m venv .venv
    .venv/bin/python -m pip install matplotlib
    .venv/bin/python scripts/plot_metrics.py
    .venv/bin/python scripts/plot_metrics.py path/to/metrics.jsonl
    .venv/bin/python scripts/plot_metrics.py --output chart.png --no-show

The default input is Flatserve/metrics.jsonl relative to this script's repository,
independent of the working directory. Explicit paths use the working directory.
Only the input file is read; metric recording is unchanged.

Request and GetBytes points use the request completion timestamp. GetBytes sums
all dataset calls with the same TraceId, regardless of file order. A missing
GetBytes match is a gap, rather than a measured zero. TraceIds are expected to
identify one request; ambiguous matches are warned about and left as gaps.

GC records with StartTimestamp and EndTimestamp shade actual runtime suspension
intervals in red. Restart the updated server to record these boundaries. Legacy
sampled observations remain timestamp markers and are never assigned intervals.
gc_total records are cumulative and are ignored. Lower-panel bar widths are only
for visibility, not pause intervals; caps distinguish overlapping pause durations.

The interactive window has a compact sidebar with shared time-range controls,
separate duration-range controls, and Linear / Log (zero-safe) scale selectors. Log mode
uses symlog: linear within 1 ms of zero and logarithmic beyond it. Slider values
always use seconds or milliseconds. Reset view restores full ranges and linear
scales. --output saves the initial chart before controls are added; --no-show
exports without controls. The window toolbar can save the interactive figure.
Zoom in, then left-click and drag inside either panel to pan within the original
chart bounds. Time moves in both panels; vertical movement affects only the
dragged panel. Sidebar ranges follow the view. Toolbar pan/zoom takes precedence
when enabled.
"""

import argparse
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys


DEFAULT_INPUT = Path(__file__).resolve().parents[1] / "Flatserve" / "metrics.jsonl"
RECORD_TYPES = ("request", "get_bytes", "gc_pause")


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


@dataclass(frozen=True)
class Metric:
    timestamp: datetime
    kind: str
    duration_ms: float
    trace_id: str | None
    line: int
    start: datetime | None = None
    end: datetime | None = None


@dataclass
class Metrics:
    records: list[Metric]
    ignored: int = 0
    malformed: int = 0


def parse_timestamp(value, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO 8601 string with a timezone")
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.utcoffset() is None:
        raise ValueError(f"{field} must include a timezone")
    return timestamp.astimezone(timezone.utc)


def load_metrics(path: Path) -> Metrics:
    metrics = Metrics([])
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            trailing = not line.endswith("\n")
            if trailing:
                warn(f"line {line_number}: final line has no newline; it may be incomplete")
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError("expected a JSON object")
                kind = record.get("Type")
                if kind not in RECORD_TYPES:
                    metrics.ignored += 1
                    continue
                timestamp = parse_timestamp(record.get("Timestamp"), "Timestamp")
                duration = record.get("DurationUs")
                if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                        or not math.isfinite(duration) or duration < 0):
                    raise ValueError("DurationUs must be a finite, non-negative number")
                trace_id = record.get("TraceId")
                if trace_id is not None and (not isinstance(trace_id, str) or not trace_id.strip()):
                    raise ValueError("TraceId must be a non-empty string or null")
                start = end = None
                if kind == "gc_pause" and ("StartTimestamp" in record or "EndTimestamp" in record):
                    start = parse_timestamp(record.get("StartTimestamp"), "StartTimestamp")
                    end = parse_timestamp(record.get("EndTimestamp"), "EndTimestamp")
                    if end < start:
                        raise ValueError("EndTimestamp must not precede StartTimestamp")
                    timestamp = end
                    duration = (end - start).total_seconds() * 1_000_000
                metrics.records.append(Metric(
                    timestamp, kind, duration / 1000, trace_id, line_number, start, end
                ))
            except (ValueError, OverflowError) as error:
                metrics.malformed += 1
                description = "incomplete or malformed trailing record" if trailing else "malformed record"
                warn(f"line {line_number}: skipping {description}: {error}")
    metrics.records.sort(key=lambda record: record.timestamp)
    return metrics


def match_get_bytes(requests: list[Metric], calls: list[Metric]) -> tuple[list[float], int]:
    """Return sums aligned with requests, using NaN for unmeasured/ambiguous sums."""
    requests_by_trace = defaultdict(list)
    for index, request in enumerate(requests):
        if request.trace_id is not None:
            requests_by_trace[request.trace_id].append(index)
    for trace_id, indices in requests_by_trace.items():
        if len(indices) > 1:
            warn(f"TraceId {trace_id!r} identifies {len(indices)} requests; cannot uniquely match GetBytes")

    durations = [math.nan] * len(requests)
    unmatched = 0
    for call in calls:
        indices = requests_by_trace.get(call.trace_id, [])
        if len(indices) != 1:
            unmatched += 1
            warn(f"line {call.line}: unmatched GetBytes record (TraceId={call.trace_id!r})")
            continue
        index = indices[0]
        durations[index] = call.duration_ms + (0 if math.isnan(durations[index]) else durations[index])
    return durations, unmatched


def plot_metrics(metrics: Metrics, source: Path):
    import matplotlib.pyplot as plt

    requests = [record for record in metrics.records if record.kind == "request"]
    calls = [record for record in metrics.records if record.kind == "get_bytes"]
    pauses = [record for record in metrics.records if record.kind == "gc_pause"]
    intervals = [pause for pause in pauses if pause.start is not None]
    sampled = [pause for pause in pauses if pause.start is None]
    get_bytes_ms, unmatched = match_get_bytes(requests, calls)
    matched_requests = sum(not math.isnan(value) for value in get_bytes_ms)
    summary = (
        f"Requests: {len(requests)} | GetBytes: {len(calls)} calls, {matched_requests} matched requests, "
        f"{unmatched} unmatched calls\n"
        f"GC: {len(intervals)} recorded intervals, {len(sampled)} sampled pauses | "
        f"Ignored: {metrics.ignored} | Malformed: {metrics.malformed}"
    )
    print(summary)

    origin = min((record.start or record.timestamp for record in metrics.records), default=None)

    def elapsed(record: Metric) -> float:
        return (record.timestamp - origin).total_seconds()

    figure, (timing_ax, gc_ax) = plt.subplots(
        2, 1, sharex=True, figsize=(13, 8), gridspec_kw={"height_ratios": [3, 1]}
    )
    figure.suptitle(f"Flatserve timings — {source.name}", fontsize=15)
    figure.text(0.5, 0.92, summary, ha="center", va="top", fontsize=10)

    request_times = [elapsed(request) for request in requests]
    timing_ax.plot(request_times, [request.duration_ms for request in requests],
                   ".-", markersize=3, linewidth=1, label="Whole request")
    timing_ax.plot(request_times, get_bytes_ms, ".-", markersize=3, linewidth=1,
                   label="GetBytes (sum per request)")
    if not requests:
        timing_ax.text(0.5, 0.5, "No request records", transform=timing_ax.transAxes, ha="center")
    elif not matched_requests:
        timing_ax.text(0.5, 0.85, "No matched GetBytes records", transform=timing_ax.transAxes, ha="center")

    span = elapsed(metrics.records[-1]) if metrics.records else 0
    bar_width = max(span, 1) / 400
    # Draw larger bars first so smaller pauses at the same timestamp stay visible.
    for series, label, alpha in ((intervals, "GC pause (recorded interval)", 0.8),
                                 (sampled, "GC pause (sampled observation)", 0.45)):
        if series:
            ordered = sorted(series, key=lambda pause: pause.duration_ms, reverse=True)
            gc_ax.bar([elapsed(pause) for pause in ordered],
                      [pause.duration_ms for pause in ordered], width=bar_width,
                      color="tab:red", edgecolor="tab:red", alpha=alpha, label=label)
    # Keep a legend even when the GC series is absent.
    if not pauses:
        gc_ax.plot([], [], color="tab:red", label="GC pause")
    gc_ax.plot([elapsed(pause) for pause in pauses], [pause.duration_ms for pause in pauses],
               linestyle="none", marker="_", color="tab:red", markersize=7)
    for index, pause in enumerate(intervals):
        timing_ax.axvspan((pause.start - origin).total_seconds(), (pause.end - origin).total_seconds(),
                          color="red", alpha=0.2, linewidth=0, zorder=0,
                          label="GC pause interval" if index == 0 else None)
    for index, timestamp in enumerate(sorted({pause.timestamp for pause in sampled})):
        timing_ax.axvline((timestamp - origin).total_seconds(), color="tab:red", alpha=0.4,
                          linewidth=0.8, label="GC sampled observation" if index == 0 else None)
    if not pauses:
        gc_ax.text(0.5, 0.5, "No GC pause observations", transform=gc_ax.transAxes, ha="center")

    timing_ax.set_ylabel("Duration (ms)")
    gc_ax.set_ylabel("Pause (ms)")
    gc_ax.set_xlabel("Time elapsed (s)")
    for axis in (timing_ax, gc_ax):
        axis.set_ylim(bottom=0)
        axis.grid(True, alpha=0.25)
        axis.set_axisbelow(True)
        axis.legend(loc="upper right", fontsize=9)
    padding = max(span * 0.01, bar_width)
    gc_ax.set_xlim(-padding, span + padding if span else 1)
    figure.text(0.5, 0.025,
                "Red shading shows recorded GC suspension intervals; legacy samples are markers only.\n"
                "Lower-panel bar widths do not represent pause intervals. "
                "Overlapping pauses have individual caps. Missing GetBytes matches appear as gaps.",
                ha="center", fontsize=9)
    figure.tight_layout(rect=(0, 0.07, 1, 0.87))
    return figure


class ChartControls:
    """Keep widgets alive and apply range/scale selections to the chart axes."""

    def __init__(self, figure):
        from matplotlib.widgets import Button, RadioButtons, RangeSlider

        self.figure = figure
        timing_ax, gc_ax = figure.axes
        self.axes = {
            "time": (timing_ax, "x", 0.001),
            "timing": (timing_ax, "y", 1),
            "gc": (gc_ax, "y", 1),
        }
        self.initial_limits = {
            key: tuple(getattr(axis, f"get_{direction}lim")())
            for key, (axis, direction, _) in self.axes.items()
        }
        self.sliders = {}
        self.scales = {}

        figure.set_size_inches(15, 8, forward=True)
        figure.subplots_adjust(right=0.79)
        # Keep titles and notes centered over the charts rather than the sidebar.
        chart_center = (figure.subplotpars.left + figure.subplotpars.right) / 2
        for text in figure.texts:
            text.set_x(chart_center)
        figure.texts[-1].set_fontsize(8)
        figure.text(0.825, 0.9, "View controls", fontsize=10, weight="bold")
        rows = (("time", "Time range (s)", 0.79),
                ("timing", "Timing range (ms)", 0.56),
                ("gc", "GC pause range (ms)", 0.33))
        for key, label, y in rows:
            bounds = self.initial_limits[key]
            slider_ax = figure.add_axes((0.835, y, 0.135, 0.022))
            slider_ax.set_title(label, loc="left", fontsize=9, pad=10)
            slider = RangeSlider(slider_ax, "", *bounds, valinit=bounds,
                                 valfmt="%.4g", handle_style={"size": 6})
            slider.valtext.set_fontsize(8)
            slider.valtext.set_position((0.5, -0.4))
            slider.valtext.set_horizontalalignment("center")
            slider.valtext.set_verticalalignment("top")
            slider.on_changed(lambda values, key=key: self.set_range(key, values))
            self.sliders[key] = slider

            selector_ax = figure.add_axes((0.825, y - 0.115, 0.155, 0.075), frameon=False)
            selector = RadioButtons(selector_ax,
                                    ("Linear", "Log (zero-safe)"), active=0)
            for text in selector.labels:
                text.set_fontsize(8)
            selector.on_clicked(lambda label, key=key: self.set_scale(key, label))
            self.scales[key] = selector

        self.reset_button = Button(figure.add_axes((0.835, 0.1, 0.135, 0.035)), "Reset view")
        self.reset_button.label.set_fontsize(9)
        self.reset_button.on_clicked(self.reset)
        self._pan_state = None
        self._connections = [
            figure.canvas.mpl_connect(name, callback)
            for name, callback in (
                ("button_press_event", self.start_pan),
                ("motion_notify_event", self.drag_pan),
                ("button_release_event", self.end_pan),
                ("figure_leave_event", self.end_pan),
                ("close_event", self.close),
            )
        ]

    def start_pan(self, event):
        from matplotlib.backend_bases import MouseButton

        timing_ax = self.axes["timing"][0]
        gc_ax = self.axes["gc"][0]
        canvas = self.figure.canvas
        toolbar = canvas.toolbar
        if (event.button != MouseButton.LEFT or event.inaxes not in (timing_ax, gc_ax)
                or self._pan_state is not None or (toolbar and toolbar.mode)
                or not canvas.widgetlock.available(self)):
            return
        axis = event.inaxes
        keys = ("time", "timing" if axis is timing_ax else "gc")
        spans = {}
        for key in keys:
            target, direction, _ = self.axes[key]
            transform = getattr(target, f"{direction}axis").get_transform()
            low, high = transform.transform(getattr(target, f"get_{direction}lim")())
            spans[key] = high - low
        canvas.widgetlock(self)
        axis.start_pan(event.x, event.y, MouseButton.LEFT)
        self._pan_state = (axis, keys, spans)

    def drag_pan(self, event):
        from matplotlib.backend_bases import MouseButton

        if self._pan_state is None or event.x is None or event.y is None:
            return
        axis, keys, spans = self._pan_state
        axis.drag_pan(MouseButton.LEFT, event.key, event.x, event.y)
        for key in keys:
            target, direction, _ = self.axes[key]
            transform = getattr(target, f"{direction}axis").get_transform()
            bounds = self.initial_limits[key]
            bound_low, bound_high = transform.transform(bounds)
            proposed_low = transform.transform(getattr(target, f"get_{direction}lim")())[0]
            width = spans[key]
            if width >= bound_high - bound_low or math.isclose(width, bound_high - bound_low,
                                                              rel_tol=1e-12):
                limits = bounds
            else:
                low = min(max(proposed_low, bound_low), bound_high - width)
                limits = transform.inverted().transform((low, low + width))
                limits = (max(bounds[0], limits[0]), min(bounds[1], limits[1]))
            getattr(target, f"set_{direction}lim")(*limits)
            # Reflect the pan without triggering slider callbacks that would reapply limits.
            slider = self.sliders[key]
            eventson = slider.eventson
            slider.eventson = False
            try:
                slider.set_val(limits)
            finally:
                slider.eventson = eventson
        self.figure.canvas.draw_idle()

    def end_pan(self, event=None):
        if self._pan_state is not None:
            self._pan_state[0].end_pan()
            self._pan_state = None
            if self.figure.canvas.widgetlock.isowner(self):
                self.figure.canvas.widgetlock.release(self)

    def close(self, event=None):
        self.end_pan()
        for connection in self._connections:
            self.figure.canvas.mpl_disconnect(connection)
        self._connections.clear()

    def set_range(self, key, values):
        lower, upper = values
        if lower >= upper:
            return
        axis, direction, _ = self.axes[key]
        getattr(axis, f"set_{direction}lim")(lower, upper)
        self.figure.canvas.draw_idle()

    def set_scale(self, key, label):
        axis, direction, threshold = self.axes[key]
        limits = getattr(axis, f"get_{direction}lim")()
        setter = getattr(axis, f"set_{direction}scale")
        if label == "Linear":
            setter("linear")
        else:
            setter("symlog", linthresh=threshold)
        self.set_range(key, limits)

    def reset(self, event=None):
        self.end_pan()
        for key in self.axes:
            self.scales[key].set_active(0)
            self.sliders[key].set_val(self.initial_limits[key])
        self.figure.canvas.draw_idle()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT, help="metrics JSON-lines file")
    parser.add_argument("--output", type=Path, help="save the chart as a PNG")
    parser.add_argument("--no-show", action="store_true", help="do not open a plot window")
    args = parser.parse_args()
    try:
        metrics = load_metrics(args.input)
        if args.output and args.output.resolve() == args.input.resolve():
            parser.error("--output must differ from the input metrics file")
        import matplotlib
        if args.no_show:
            matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        figure = plot_metrics(metrics, args.input)
        if args.output:
            figure.savefig(args.output, format="png", dpi=160)
            print(f"Saved {args.output}")
        if not args.no_show:
            # Figure ownership retains widget/callback references until the window closes.
            figure._metrics_controls = ChartControls(figure)
            plt.show()
        plt.close(figure)
    except ModuleNotFoundError as error:
        if error.name != "matplotlib":
            raise
        parser.exit(1, "Matplotlib is required. Install it with: python3 -m pip install matplotlib\n")
    except (OSError, ValueError) as error:
        parser.exit(1, f"error: {error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
