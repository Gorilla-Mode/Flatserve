using Flatserve.Fgb;

namespace Flatserve.Index;

public sealed class HashIndex : IIndex<string>
{
    private readonly Dictionary<string, List<FgbFeaturePtr>> _index = new Dictionary<string, List<FgbFeaturePtr>>();
    
    public void Add(string value, FgbFeaturePtr featurePtr)
    {
        if (!_index.TryGetValue(value, out var featurePtrs))
        {
            featurePtrs = [];
            _index.Add(value, featurePtrs);
        }
        
        featurePtrs.Add(featurePtr);
    }

    public IReadOnlyList<FgbFeaturePtr> Get(string key)
    {
        if (!_index.TryGetValue(key, out var featurePtrs))
        {
            return Array.Empty<FgbFeaturePtr>();
        }

        return featurePtrs;
    }
}