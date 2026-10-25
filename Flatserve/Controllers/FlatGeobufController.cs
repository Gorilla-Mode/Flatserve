using Flatserve.Fgb;
using Microsoft.AspNetCore.Mvc;
using NetTopologySuite.Geometries;

namespace Flatserve.Controllers;

[ApiController]
[Route("fgb")]
public class FlatGeobufController(FgbDataset fgbDataset) : ControllerBase
{
    [HttpGet]
    [Route("collection/{minX:double}/{maxX:double}/{minY:double}/{maxY:double}")]
    public IActionResult Collection(double minX, double maxX, double minY, double maxY)
    {
        var bbox = new Envelope(minX, maxX, minY, maxY);
        
        return File(fgbDataset.GetBytes(bbox), "application/octet-stream");
    }

    [HttpGet]
    [Route("feature/{featureIndex:int}")]
    public IActionResult FeatureString(int featureIndex)
    {
        return File(fgbDataset.GetFeatureBytes(fgbDataset.FeaturePtrs[featureIndex]), "application/octet-stream");
    }
}
