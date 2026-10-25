namespace Flatserve.Fgb;

public readonly record struct FgbFeaturePtr
{
    public ulong Offset { get; init; }
    public ulong Length { get; init; }
    
    public FgbFeaturePtr(ulong offset, ulong length)
    {
        Offset = offset;
        Length = length;
    }
}