using NetTopologySuite.Features;
using NetTopologySuite.Geometries;
using NetTopologySuite.IO;

namespace Flatserve.User;

public class User
{
    public int id { get; init; }
    public required Polygon AuthPolygon { get; init; }
    
    public string AuthPolygonGeoJson()
    {
        var feature = new Feature(AuthPolygon, new AttributesTable { { "userId", id } });
        
        return new GeoJsonWriter().Write(feature);
    }
}

