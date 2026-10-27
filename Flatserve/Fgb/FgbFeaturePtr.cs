namespace Flatserve.Fgb;

public readonly record struct FgbFeaturePtr
{
    public const int LengthPrefix = sizeof(uint); // FlatGeobuf uses a 4-byte length prefix for features
    
    public ulong Offset { get; init; }
    public ulong Length { get; init; }
    public ulong PayloadOffset => checked(Offset + LengthPrefix);
    public ulong PayloadLength => checked(Length - LengthPrefix); 
    
    public FgbFeaturePtr(ulong offset, ulong length)
    {
        Offset = offset;
        Length = length;
    }
}