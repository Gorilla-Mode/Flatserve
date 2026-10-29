using NetTopologySuite.Geometries;

namespace Flatserve.User;

public class User
{
    public int id { get; init; }
    public required Polygon AuthPolygon { get; init; }
}

