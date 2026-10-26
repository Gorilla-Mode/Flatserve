using Flatserve.Fgb;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using NetTopologySuite.Geometries;

namespace Flatserve.Controllers;

[ApiController]
[Route("fgb")]
public class FlatGeobufController(FgbDataset fgbDataset) : ControllerBase
{
    [HttpGet]
    [Route("collection")]
    public IActionResult Collection(
        [FromQuery, BindRequired] double minX,
        [FromQuery, BindRequired] double minY,
        [FromQuery, BindRequired] double maxX,
        [FromQuery, BindRequired] double maxY)
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

        var bbox = new Envelope(minX, maxX, minY, maxY);
        return File(fgbDataset.GetBytes(bbox), "application/octet-stream");
    }

    [HttpGet]
    [Route("feature/{featureIndex:int}")]
    public IActionResult FeatureString(int featureIndex)
    {
        if (featureIndex < 0 || featureIndex >= fgbDataset.FeaturePtrs.Count)
            return BadRequest("Feature index is out of bounds.");

        return File(fgbDataset.GetFeatureBytes(fgbDataset.FeaturePtrs[featureIndex]), "application/octet-stream");
    }

    [HttpGet]
    [Route("filter")]
    public IActionResult FilterTextAttribure(
        [FromQuery, BindRequired]string attribute,
        [FromQuery, BindRequired]string value)
    {
        return File(fgbDataset.FilterTextAttribute(attribute, value), "application/octet-stream");
    }
}
