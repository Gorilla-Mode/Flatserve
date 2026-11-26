namespace Flatserve.Fgb;

using System.IO.Pipelines;

internal sealed class BodyWriterStream(PipeWriter writer) : Stream
{
    private const int FlushThreshold = 256 * 1024;
    private int _pendingBytes;

    public override void Write(byte[] buffer, int offset, int count) =>
        Write(buffer.AsSpan(offset, count));

    public override void Write(ReadOnlySpan<byte> source)
    {
        while (!source.IsEmpty)
        {
            Span<byte> destination = writer.GetSpan(1);
            int count = Math.Min(source.Length, destination.Length);
            count = Math.Min(count, FlushThreshold - _pendingBytes);

            source[..count].CopyTo(destination);
            writer.Advance(count);
            _pendingBytes += count;
            source = source[count..];

            if (_pendingBytes == FlushThreshold)
                Flush();
        }
    }

    public override void Flush()
    {
        if (_pendingBytes == 0)
            return;

        var flush = writer.FlushAsync();
        var result = flush.IsCompletedSuccessfully
            ? flush.Result
            : flush.AsTask().GetAwaiter().GetResult();

        if (result.IsCanceled || result.IsCompleted)
            throw new IOException("The response pipe stopped accepting data.");

        _pendingBytes = 0;
    }

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public override void SetLength(long value) =>
        throw new NotSupportedException();
}