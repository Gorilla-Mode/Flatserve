using Flatserve.Fgb;

namespace Flatserve.Index;

public interface IIndex<in T>
{
    void Add(T key, FgbFeaturePtr featurePtr);
    IReadOnlyList<FgbFeaturePtr> Get(T key);
}