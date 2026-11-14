using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using FlatGeobuf;
using FlatGeobuf.Index;
using FlatGeobuf.NTS;
using Flatserve.Index;
using Google.FlatBuffers;
using NetTopologySuite.Geometries;
using NetTopologySuite.Operation.Valid;

namespace Flatserve.Fgb;

public record FgbDataset
{
    public readonly List<FgbFeaturePtr> FeaturePtrs = new List<FgbFeaturePtr>();
    
    private readonly byte[] _data;
    private readonly byte[] _spatialIndex = [];
    private readonly HeaderT _header;
    private readonly Dictionary<string, HashIndex> _textIndexes = new Dictionary<string, HashIndex>();
    private byte[] _exportHeader = [];
    public IReadOnlyList<TextIndexMetadata> TextIndexesMeta;
    private readonly ILogger<FgbDataset> _logger;
    private readonly MetricsWriter _metrics;
    private readonly string _dataset;

    public FgbDataset(string filePath, ILogger<FgbDataset> logger, MetricsWriter metrics, IEnumerable<string>? textIndexes = null)
    {
        var raw = File.ReadAllBytes(filePath);

        using var stream = new MemoryStream(raw, false);
        using var reader = new BinaryReader(stream);
        
        var originalHeader = Helpers.ReadHeader(stream);
        _header = originalHeader.UnPack();
        
        CreateExportHeader(originalHeader);

        // fill index
        if (_header.IndexNodeSize > 0 && _header.FeaturesCount > 0)
        {
            int indexSize = checked((int)PackedRTree.CalcSize(
                _header.FeaturesCount, _header.IndexNodeSize));

            _spatialIndex = new byte[indexSize];
            stream.ReadExactly(_spatialIndex);
        }

        _data = new byte[checked((int)(stream.Length - stream.Position))];
        stream.ReadExactly(_data);
        
        using var featureStream = new MemoryStream(_data, false);
        using var featureReader = new BinaryReader(featureStream);
        FeaturePtrs = GetFeaturePtrs(featureStream, featureReader);

        if (textIndexes != null)
        {
            foreach (var attribute in textIndexes)
            {
                if (_header.Columns?.Any(column => column.Name == attribute && column.Type == ColumnType.String) ==
                    true)
                    BuildTextIndex(attribute);
            }
        }
        
        var metadata = new List<TextIndexMetadata>();

        foreach (var (attribute, index) in _textIndexes)
        {
            metadata.Add(new TextIndexMetadata(attribute, index.Values.ToArray()));
        }
        
        TextIndexesMeta = metadata.AsReadOnly();
        _logger = logger;
        _metrics = metrics;
        _dataset = Path.GetFileNameWithoutExtension(filePath);
    }

    private void CreateExportHeader(Header originalHeader)
    {
        var exportHeader = originalHeader.UnPack();
        
        exportHeader.IndexNodeSize = 0;
        exportHeader.FeaturesCount = 0; // Unknown count; readers continue until EOF.
        
        var builder = new FlatBufferBuilder(1024);
        var headerOffset = Header.Pack(builder, exportHeader);
        
        builder.FinishSizePrefixed(headerOffset.Value);
        var headerBytes = builder.SizedByteArray();
        _exportHeader = new byte[Constants.MagicBytes.Length + headerBytes.Length];
        
        Constants.MagicBytes.CopyTo(_exportHeader, 0);
        headerBytes.CopyTo(_exportHeader, Constants.MagicBytes.Length);
    }

    public Byte[] GetBytes(Envelope bbox, Polygon allowedArea)
    {
        if (_spatialIndex.Length == 0)
            throw new InvalidOperationException("Spatial index is empty");
        
        var logInformation = _logger.IsEnabled(LogLevel.Information);
        var recordMetrics = _metrics.Enabled;
        var measure = recordMetrics || logInformation;
        var started = measure ? Stopwatch.GetTimestamp() : 0;
        using var output = new MemoryStream();
        output.Write(_exportHeader);
        
        Stream ReadNode(ulong offset, ulong length)
        {
            return new MemoryStream(
                _spatialIndex,
                checked((int)offset),
                checked((int)length),
                writable: false);
        }
        
        var start = measure ? Stopwatch.GetTimestamp() : 0;
        var events = logInformation ? new StringBuilder() : null;
        var featureMetrics = recordMetrics ? new List<object>() : null;
        var written = 0;
        
        var intersects = PackedRTree.StreamSearch(
            _header.FeaturesCount,
            _header.IndexNodeSize,
            bbox,
            ReadNode);
        
        var searchSetupUs = measure ? Stopwatch.GetElapsedTime(start).TotalMicroseconds : 0;
        if (logInformation)
            events!.Append($"\tWalked R-Tree in {searchSetupUs:F3} μs\n");

        var sequenceFactory = new FlatGeobufCoordinateSequenceFactory();
        var factory = new GeometryFactory(sequenceFactory);
        
        foreach (var intersect in intersects)
        {
            var startIntersect = measure ? Stopwatch.GetTimestamp() : 0;
            if (logInformation)
                events!.Append($"\t\tProcessing feature {intersect.Index} at offset {intersect.Offset}\n");
            
            var startDecode = recordMetrics ? Stopwatch.GetTimestamp() : 0;
            ulong payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(
                _data.AsSpan(
                    checked((int)intersect.Offset),
                    FgbFeaturePtr.LengthPrefix));

            var pointer = new FgbFeaturePtr(
                intersect.Offset,
                checked(payloadLength + FgbFeaturePtr.LengthPrefix));
            
            var feature = FeatureConversions.FromByteBuffer(factory,
                sequenceFactory,
                new ByteBuffer(GetRawFeatureBytes(pointer)),
                _header);

            var decodeUs = recordMetrics ? Stopwatch.GetElapsedTime(startDecode).TotalMicroseconds : 0;
            var startAuthCheck = measure ? Stopwatch.GetTimestamp() : 0;
            var accepted = feature.Geometry is not null && allowedArea.Intersects(feature.Geometry);
            var authUs = measure ? Stopwatch.GetElapsedTime(startAuthCheck).TotalMicroseconds : 0;
            var writeUs = 0d;

            if (accepted)
            {
                if (logInformation)
                    events!.Append($"\t\t  Intersected with allowed area in {authUs:F3} μs\n");
                var startWrite = recordMetrics ? Stopwatch.GetTimestamp() : 0;
                WriteFeature(output, pointer);
                writeUs = recordMetrics ? Stopwatch.GetElapsedTime(startWrite).TotalMicroseconds : 0;
                written++;
                if (logInformation)
                    events!.Append(
                        $"\t\t  Written to buffer in {Stopwatch.GetElapsedTime(startIntersect).TotalMicroseconds:F3} μs\n");
            }

            if (recordMetrics)
            {
                featureMetrics!.Add(new
                {
                    FeatureIndex = intersect.Index,
                    Offset = intersect.Offset,
                    Accepted = accepted,
                    DecodeUs = decodeUs,
                    AuthorizationUs = authUs,
                    WriteUs = writeUs,
                    DurationUs = Stopwatch.GetElapsedTime(startIntersect).TotalMicroseconds
                });
            }
        }

        var result = output.ToArray();
        var elapsed = measure ? Stopwatch.GetElapsedTime(started) : TimeSpan.Zero;
        if (recordMetrics)
        {
            _metrics.Write(new
            {
                Timestamp = DateTimeOffset.UtcNow,
                Type = "get_bytes",
                TraceId = Activity.Current?.TraceId.ToString(),
                Dataset = _dataset,
                DurationUs = elapsed.TotalMicroseconds,
                SearchSetupUs = searchSetupUs,
                CandidateCount = featureMetrics!.Count,
                WrittenCount = written,
                Bytes = result.Length,
                Features = featureMetrics
            });
        }

        if (logInformation)
        {
            events!.Append($"\tProcessed {written} features in {elapsed.TotalMilliseconds:F3} ms\n");
            _logger.LogInformation("GetBytes:\n{Events}", events.ToString());
        }
        return result;
    }
    
    public Byte[] GetFeatureBytes(FgbFeaturePtr featurePtr)
    {
        using var output = new MemoryStream();
        
        output.Write(_exportHeader);
        WriteFeature(output, featurePtr);
        
        return output.ToArray();
    }

    private byte[] GetRawFeatureBytes(FgbFeaturePtr featurePtr) =>
        _data.AsSpan(
            checked((int)featurePtr.PayloadOffset),
            checked((int)featurePtr.PayloadLength)).ToArray(); 

    private void WriteFeature(Stream output, FgbFeaturePtr featurePtr) =>
        output.Write(_data.AsSpan(
            checked((int)featurePtr.Offset),
            checked((int)featurePtr.Length)));

    public Byte[] FilterTextAttribute(string attribute, string value)
    {
        var features = _textIndexes.TryGetValue(attribute, out var index)
            ? index.Get(value)
            : Array.Empty<FgbFeaturePtr>();
        
        using var output = new MemoryStream();
        output.Write(_exportHeader);

        foreach (var feature in features)
        {
            WriteFeature(output, feature);
        }

        return output.ToArray();
    }

    private List<FgbFeaturePtr> GetFeaturePtrs(MemoryStream stream, BinaryReader reader)
    {
        List<FgbFeaturePtr> fgbFeaturePtrs = new List<FgbFeaturePtr>();
        
        while (stream.Position < stream.Length)
        {
            ulong offset = Convert.ToUInt64(stream.Position);
            ulong payloadLength = reader.ReadUInt32();

            fgbFeaturePtrs.Add(new FgbFeaturePtr(
                offset,
                checked(payloadLength + FgbFeaturePtr.LengthPrefix)));

            stream.Position += Convert.ToInt64(payloadLength);

        }
        
        return fgbFeaturePtrs;
    }

    private void AddToTextIndex(string attribute, string value, FgbFeaturePtr featurePtr)
    {
        if (!_textIndexes.TryGetValue(attribute, out var index))
        {
            index = new HashIndex();
            _textIndexes.Add(attribute, index);
        }

        index.Add(value, featurePtr);
    }

    private void BuildTextIndex(string attribute)
    {
        // Preserve the built index even when this layer contains no string values.
        _textIndexes.TryAdd(attribute, new HashIndex());
        var sequenceFactory = new FlatGeobufCoordinateSequenceFactory();
        var factory = new GeometryFactory(sequenceFactory);
        
        foreach (var pointer in FeaturePtrs)
        {
            var feature = FeatureConversions.FromByteBuffer(factory,
                sequenceFactory,
                new ByteBuffer(GetRawFeatureBytes(pointer)),
                _header);

            var attributes = feature.Attributes;
            
            if (attributes is not null &&
                attributes.Exists(attribute) &&
                attributes[attribute] is string value)
            {
                AddToTextIndex(attribute, value, pointer);
            }
        }
    }
}
