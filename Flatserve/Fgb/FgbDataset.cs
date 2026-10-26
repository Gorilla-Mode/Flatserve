using System.Buffers.Binary;
using FlatGeobuf;
using FlatGeobuf.Index;
using Flatserve.Index;
using NetTopologySuite.Geometries;

namespace Flatserve.Fgb;

public record FgbDataset
{
    private readonly byte[] _data;
    public readonly List<FgbFeaturePtr> FeaturePtrs = new List<FgbFeaturePtr>();
    private readonly byte[] _spatialIndex = [];
    private readonly HeaderT _header;
    private readonly Dictionary<string, HashIndex> _textIndexes = new Dictionary<string, HashIndex>();

    public FgbDataset(string filePath)
    {
        var raw = File.ReadAllBytes(filePath);

        using var stream = new MemoryStream(raw, false);
        using var reader = new BinaryReader(stream);
        
        _header = Helpers.ReadHeader(stream).UnPack();
        
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
    }

    public Byte[] GetBytes(Envelope bbox)
    {
        if (_spatialIndex.Length == 0)
            throw new InvalidOperationException("Spatial index is empty");
        
        using var output = new MemoryStream();
        
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
            int offset = checked((int)intersect.Offset);

            int length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(
                _data.AsSpan(offset, 4)));

            output.Write(_data.AsSpan(offset, checked(4 + length)));
        }
                
        return output.ToArray();
    }
    
    public Byte[] GetFeatureBytes(FgbFeaturePtr featurePtr)
    {
        return _data.AsSpan((int)featurePtr.Offset, (int)featurePtr.Length).ToArray();
    }

    private List<FgbFeaturePtr> GetFeaturePtrs(MemoryStream stream, BinaryReader reader)
    {
        List<FgbFeaturePtr> fgbFeaturePtrs = new List<FgbFeaturePtr>();
        
        while (stream.Position < stream.Length)
        {
            ulong featureLen = reader.ReadUInt32();
            ulong offset = Convert.ToUInt64(stream.Position);

            FgbFeaturePtr featurePtr = new(offset, featureLen);
            
            fgbFeaturePtrs.Add(featurePtr);
                                                                                                   
            stream.Position += Convert.ToInt64(featureLen);
        }
        
        return fgbFeaturePtrs;
    }
}