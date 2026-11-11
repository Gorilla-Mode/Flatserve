using Flatserve.Fgb;

namespace Flatserve.Index;

public sealed class HashIndex : IIndex<string>
{
    private static readonly Dictionary<string, List<FgbFeaturePtr>> Index = new Dictionary<string, List<FgbFeaturePtr>>();
    public static IEnumerable<string> Values => Index.Keys;
    
    public void Add(string value, FgbFeaturePtr featurePtr)
    {
        if (!Index.TryGetValue(value, out var featurePtrs))
        {
            featurePtrs = [];
            Index.Add(value, featurePtrs);
        }
        
        featurePtrs.Add(featurePtr);
    }

    public IReadOnlyList<FgbFeaturePtr> Get(string key)
    {
        if (!Index.TryGetValue(key, out var featurePtrs))
        {
            return Array.Empty<FgbFeaturePtr>();
        }

        return featurePtrs;
    }
}
