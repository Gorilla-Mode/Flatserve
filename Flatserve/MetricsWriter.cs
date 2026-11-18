using System.Text.Json;
using System.Threading.Channels;

namespace Flatserve;

/// <summary>Queues data-only records; one background task serializes and writes JSON lines.</summary>
public sealed class MetricsWriter : IAsyncDisposable
{
    private readonly Channel<object>? _records;
    private readonly StreamWriter? _file;
    private readonly Task? _writerTask;

    public bool Enabled { get; }

    public MetricsWriter(string path, bool enabled = true)
    {
        Enabled = enabled;
        if (!enabled)
            return;

        _file = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write,
            FileShare.Read, 65536, FileOptions.Asynchronous));
        _records = Channel.CreateUnbounded<object>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
        _writerTask = Task.Run(WriteRecordsAsync);
    }

    // Only enqueue here: no JSON serialization, file I/O, or waiting on the caller.
    public void Write<T>(T metric) where T : notnull => _records?.Writer.TryWrite(metric);

    private async Task WriteRecordsAsync()
    {
        try
        {
            await foreach (var metric in _records!.Reader.ReadAllAsync())
            {
                var json = JsonSerializer.Serialize(metric, metric.GetType());
                await _file!.WriteLineAsync(json);
                await _file.FlushAsync();
            }
        }
        catch (Exception error)
        {
            _records!.Writer.TryComplete(error);
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (!Enabled)
            return;

        _records!.Writer.TryComplete();
        try
        {
            await _writerTask!;
        }
        finally
        {
            await _file!.DisposeAsync();
        }
    }
}
