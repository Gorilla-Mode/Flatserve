namespace Flatserve.Fgb;

public readonly record struct FgbFeaturePtr
{
    // FlatGeobuf uses a 4-byte length prefix for features
    public const int LengthPrefix = sizeof(uint); 
    
    public ulong Offset { get; init; }
    public ulong Length { get; init; }
    
    // Length field isn't used internally
    public ulong PayloadOffset => checked(Offset + LengthPrefix); 
    public ulong PayloadLength => checked(Length - LengthPrefix); // Cut end 
    
    public FgbFeaturePtr(ulong offset, ulong length)
    {
        Offset = offset;
        Length = length;
    }
}