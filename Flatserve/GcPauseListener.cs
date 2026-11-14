using System.Diagnostics.Tracing;

namespace Flatserve;

/// <summary>Records runtime suspension intervals using original EventPipe timestamps.</summary>
public sealed class GcPauseListener : EventListener
{
    private const string RuntimeProvider = "Microsoft-Windows-DotNETRuntime";
    private readonly object _gate = new();
    private readonly GcPauseTracker _tracker;
    private bool _ready;
    private bool _disposed;

    public GcPauseListener(MetricsWriter metrics, ILogger logger)
    {
        _tracker = new GcPauseTracker(
            pause => metrics.Write(pause),
            message => logger.LogWarning("GC pause capture: {Message}", message));
        _ready = true;
        // OnEventSourceCreated can run inside the base constructor, before our fields exist.
        foreach (var source in EventSource.GetSources())
            EnableRuntime(source);
    }

    protected override void OnEventSourceCreated(EventSource eventSource)
    {
        if (_ready)
            EnableRuntime(eventSource);
    }

    private void EnableRuntime(EventSource source)
    {
        if (source.Name == RuntimeProvider)
            EnableEvents(source, EventLevel.Informational, (EventKeywords)0x1);
    }

    protected override void OnEventWritten(EventWrittenEventArgs data)
    {
        if (!_ready || data.EventSource.Name != RuntimeProvider || data.EventId is not (9 or 3))
            return;

        int? reason = null;
        if (data.EventId == 9 && data.PayloadNames is not null && data.Payload is not null)
        {
            var index = data.PayloadNames.IndexOf("Reason");
            if (index >= 0)
                reason = Convert.ToInt32(data.Payload[index]);
        }

        lock (_gate)
        {
            if (!_disposed)
                _tracker.Process(data.EventId, new DateTimeOffset(data.TimeStamp.ToUniversalTime()), reason);
        }
    }

    public override void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
                return;
            _disposed = true;
            _tracker.Complete();
        }
        base.Dispose();
    }
}

internal sealed record GcPauseMetric(DateTimeOffset StartTimestamp, DateTimeOffset EndTimestamp)
{
    public string Type => "gc_pause";
    public DateTimeOffset Timestamp => EndTimestamp;
    public double DurationUs => (EndTimestamp - StartTimestamp).TotalMicroseconds;
}

/// <summary>Pairs suspend-begin (9) and restart-end (3), including GC preparation pauses.</summary>
internal sealed class GcPauseTracker(Action<GcPauseMetric> emit, Action<string> warn)
{
    private DateTimeOffset? _start;
    private bool _ignoreRestart;

    public void Process(int eventId, DateTimeOffset timestamp, int? reason = null)
    {
        if (eventId == 9)
        {
            if (_start is not null)
                warn("Discarding a pause with no restart before the next suspension.");
            _start = reason is 1 or 6 ? timestamp : null;
            _ignoreRestart = reason is not (1 or 6);
        }
        else if (eventId == 3)
        {
            var start = _start;
            _start = null;
            if (_ignoreRestart)
            {
                _ignoreRestart = false;
                return;
            }
            if (start is null)
                warn("Discarding a restart with no suspension start.");
            else if (timestamp < start.Value)
                warn("Discarding a pause whose end precedes its start.");
            else
                emit(new GcPauseMetric(start.Value, timestamp));
        }
    }

    public void Complete()
    {
        if (_start is not null)
            warn("Discarding an incomplete pause at shutdown.");
        _start = null;
    }
}
