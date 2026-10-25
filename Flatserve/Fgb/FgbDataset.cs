using System.Security.Cryptography;
using FlatGeobuf;
using FlatGeobuf.Index;
using Google.FlatBuffers;

namespace Flatserve.Fgb;

public record FgbDataset
{
    public readonly byte[] Data;
    public readonly List<FgbFeaturePtr> FeaturePtrs = new List<FgbFeaturePtr>();
    public readonly Index SpatialIndex;

    public FgbDataset(string filePath)
    {
        var raw = File.ReadAllBytes(filePath);

        using var stream = new MemoryStream(raw, false);
        using var reader = new BinaryReader(stream);
        
        var header = Helpers.ReadHeader(stream).UnPack();
        SpatialIndex = new Index();

        // Skip index if there is one.
        if (header.IndexNodeSize > 0 && header.FeaturesCount > 0)
        {
            stream.Position += checked((long)PackedRTree.CalcSize(
                header.FeaturesCount, header.IndexNodeSize));
        }

        Data = new byte[checked((int)(stream.Length - stream.Position))];
        stream.ReadExactly(Data);
        
        using var featureStream = new MemoryStream(Data, false);
        using var featureReader = new BinaryReader(featureStream);
        FeaturePtrs = GetFeaturePtrs(featureStream, featureReader);
    }
    
    public string FeatureToString(FgbFeaturePtr featurePtr)
    {
        Feature feature = ReadFeature(featurePtr);
        
        return feature.ToString() ?? "";
    }
    
    private Feature ReadFeature(FgbFeaturePtr featurePtr)
    {
        byte[] bytes = Data.AsSpan((int)featurePtr.Offset, (int)featurePtr.Length).ToArray();
        
        var buffer = new ByteBuffer(bytes);

        return Feature.GetRootAsFeature(buffer);
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