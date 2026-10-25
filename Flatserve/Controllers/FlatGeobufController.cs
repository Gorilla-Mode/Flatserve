using Flatserve.Fgb;
using Microsoft.AspNetCore.Mvc;

namespace Flatserve.Controllers;

[ApiController]
[Route("fgb")]
public class FlatGeobufController(FgbDataset fgbDataset) : ControllerBase
{
    [HttpGet]
    [Route("collection")]
    public IActionResult Collection()
    {
        return File(fgbDataset.Data, "application/octet-stream");
    }

    [HttpGet]
    [Route("feature/{featureIndex:int}")]
    public IActionResult FeatureString(int featureIndex)
    {
        return Content(fgbDataset.FeatureToString(fgbDataset.FeaturePtrs[featureIndex]), "text/plain");
    }
}
