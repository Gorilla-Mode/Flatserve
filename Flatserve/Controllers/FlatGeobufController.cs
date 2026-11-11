using Flatserve.Fgb;
using Flatserve.User;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using NetTopologySuite.Geometries;

namespace Flatserve.Controllers;

[ApiController]
[Route("fgb")]
public class FlatGeobufController(FgbDatasetRegistry registry) : ControllerBase
{
    [HttpGet("indexes")]
    public IActionResult Indexes() => Ok(new
    {
        layers = registry.Datasets.Select(layer => new { id = layer.Key, indexes = layer.Value.TextIndexes })
    });

    private IActionResult Export(string? layerId, Func<FgbDataset, byte[]> query)
    {
        if (layerId is not null)
            return registry.Datasets.TryGetValue(layerId, out var dataset)
                ? File(query(dataset), "application/vnd.fgb")
                : NotFound($"Layer '{layerId}' not found.");

        // Prepare every result before writing HTTP headers or any multipart bytes.
        return new MultipartFgbResult(registry.Datasets
            .Select(layer => (layer.Key, query(layer.Value))).ToArray());
    }

    [HttpGet]
    [Route("collection")]
    [Route("{layerId}/collection")]
    public IActionResult Collection(
        [FromQuery, BindRequired] int userId,
        [FromQuery, BindRequired] double minX,
        [FromQuery, BindRequired] double minY,
        [FromQuery, BindRequired] double maxX,
        [FromQuery, BindRequired] double maxY,
        [FromRoute] string? layerId = null)
    {
        if (!double.IsFinite(minX) || !double.IsFinite(minY) ||
            !double.IsFinite(maxX) || !double.IsFinite(maxY))
        {
            return BadRequest("Bounding box coordinates must be finite numbers.");
        }

        if (minX > maxX || minY > maxY)
        {
            return BadRequest("Minimum coordinates must not exceed maximum coordinates.");
        }

        if (!UserCollection.Users.TryGetValue(userId, out var user))
        {
            return BadRequest($"User with ID {userId} not found.");
        }

        var bbox = new Envelope(minX, maxX, minY, maxY);
        
        return Export(layerId, dataset => dataset.GetBytes(bbox, user.AuthPolygon));
    }

    [HttpGet]
    [Route("feature/{featureIndex:int}")]
    [Route("{layerId}/feature/{featureIndex:int}")]
    public IActionResult FeatureString(int featureIndex, [FromRoute] string? layerId = null)
    {
        if (layerId is null && registry.Datasets.Count != 1)
            return BadRequest("Specify a layer using /fgb/{layerId}/feature/{featureIndex}.");

        if (!registry.Datasets.TryGetValue(layerId ?? registry.Datasets.Keys.Single(), out var fgbDataset))
            return NotFound($"Layer '{layerId}' not found.");

        if (featureIndex < 0 || featureIndex >= fgbDataset.FeaturePtrs.Count)
            return NotFound("Feature index is out of bounds.");

        return File(fgbDataset.GetFeatureBytes(fgbDataset.FeaturePtrs[featureIndex]), "application/vnd.fgb");
    }

    [HttpGet]
    [Route("filter")]
    [Route("{layerId}/filter")]
    public IActionResult FilterTextAttribure(
        [FromQuery, BindRequired]string attribute,
        [FromQuery, BindRequired]string value,
        [FromRoute] string? layerId = null)
    {
        return Export(layerId, dataset => dataset.FilterTextAttribute(attribute, value));
    }
    
    [HttpGet]
    [Route("auth-polygon/{userId:int}")]
    public IActionResult GetAuthPolygon(
        [FromRoute, BindRequired] int userId)
    {
        if (!UserCollection.Users.TryGetValue(userId, out var user))
        {
            return BadRequest($"User with ID {userId} not found.");
        }

        return Content(user.AuthPolygonGeoJson(), "application/geo+json");
    }
}
