using System.Buffers.Binary;
using FlatGeobuf;
using FlatGeobuf.Index;
using FlatGeobuf.NTS;
using Flatserve.Index;
using Google.FlatBuffers;
using NetTopologySuite.Geometries;

namespace Flatserve.Fgb;

public record FgbDataset
{
    public readonly List<FgbFeaturePtr> FeaturePtrs = new List<FgbFeaturePtr>();
    
    private readonly byte[] _data;
    private readonly byte[] _spatialIndex = [];
    private readonly HeaderT _header;
    private readonly Dictionary<string, HashIndex> _textIndexes = new Dictionary<string, HashIndex>();
    private byte[] _exportHeader = [];
   

    public FgbDataset(string filePath)
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
        BuildTextIndex("brannvesen"); //TODO: make dynamic based on user input or configuration
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

    public Byte[] GetBytes(Envelope bbox)
    {
        if (_spatialIndex.Length == 0)
            throw new InvalidOperationException("Spatial index is empty");
        
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
        
        var intersects = PackedRTree.StreamSearch(
            _header.FeaturesCount,
            _header.IndexNodeSize,
            bbox,
            ReadNode);
        
        foreach (var intersect in intersects)
        {
            ulong payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(
                _data.AsSpan(
                    checked((int)intersect.Offset),
                    FgbFeaturePtr.LengthPrefix));

            var pointer = new FgbFeaturePtr(
                intersect.Offset,
                checked(payloadLength + FgbFeaturePtr.LengthPrefix));

            WriteFeature(output, pointer);
        }
                
        return output.ToArray();
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