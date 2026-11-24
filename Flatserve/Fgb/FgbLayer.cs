namespace Flatserve.Fgb;

public record FgbLayer(
    FgbDataset Lod0,
    FgbDataset? Lod1,
    FgbDataset? Lod2,
    FgbDataset? Lod3);
    
    

public enum FgbDetail
{
    LOD0,
    LOD1,
    LOD2,
    LOD3,
}