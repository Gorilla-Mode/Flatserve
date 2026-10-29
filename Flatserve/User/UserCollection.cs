using NetTopologySuite.Geometries;

namespace Flatserve.User;

public class UserCollection
{
    public static readonly Dictionary<int, User> Users = new Dictionary<int, User>();
    public static readonly GeometryFactory G = new GeometryFactory(new PrecisionModel(), srid: 4326);
    
    public static void AddUser(User user)
    {
        Users.Add(user.id, user);
    }
}