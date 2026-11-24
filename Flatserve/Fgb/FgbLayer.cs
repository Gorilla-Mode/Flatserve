namespace Flatserve.Fgb;

public record FgbLayer(
    FgbDataset Lod0,
    FgbDataset? Lod1,
    FgbDataset? Lod2,
    FgbDataset? Lod3);