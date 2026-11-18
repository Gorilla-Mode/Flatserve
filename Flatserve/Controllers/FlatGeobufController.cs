using Flatserve.Fgb;
using Flatserve.User;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using NetTopologySuite.Geometries;

namespace Flatserve.Controllers;

[ApiController]
[Route("fgb")]
public class FlatGeobufController(
    FgbDatasetRegistry registry,
    IConfiguration configuration,
    IWebHostEnvironment environment
    ) : ControllerBase
{
    private IActionResult Export(string? layerId, Action<FgbDataset, Stream> write)
    {
        if (layerId is not null && !registry.Datasets.ContainsKey(layerId))
            return NotFound($"Layer '{layerId}' not found.");

        var bodyControl = HttpContext.Features.Get<
            Microsoft.AspNetCore.Http.Features.IHttpBodyControlFeature>();

        if (bodyControl is not null)
            bodyControl.AllowSynchronousIO = true;

        using var body = new BufferedStream(
            Response.BodyWriter.AsStream(leaveOpen: true),
            bufferSize: 32 * 1024);

        if (layerId is not null)
        {
            Response.ContentType = "application/vnd.fgb";
            write(registry.Datasets[layerId], body);
            
            return new EmptyResult();
        }

        var boundary = Guid.NewGuid().ToString("N");
        Response.ContentType = $"multipart/mixed; boundary={boundary}";

        void WriteAscii(string text) =>
            body.Write(System.Text.Encoding.ASCII.GetBytes(text));

        foreach (var (id, dataset) in registry.Datasets)
        {
            var disposition = new System.Net.Http.Headers.ContentDispositionHeaderValue("attachment")
            {
                FileName = "layer.fgb",
                FileNameStar = id + ".fgb"
            };

            WriteAscii($"--{boundary}\r\n" +
                       "Content-Type: application/vnd.fgb\r\n" +
                       $"Content-Disposition: {disposition}\r\n\r\n");

            write(dataset, body);
            body.Write("\r\n"u8);
        }

        WriteAscii($"--{boundary}--\r\n");
        return new EmptyResult();
    }
    
    [HttpGet("indexes")]
    public IActionResult Indexes() => Ok(new
    {
        layers = registry.Datasets.Select(layer => new { id = layer.Key, indexes = layer.Value.TextIndexesMeta })
    });

    [HttpGet("style")]
    public IActionResult Style()
    {
        var dir = Path.GetFullPath(
            configuration["fgb:Directory"] ?? throw new InvalidOperationException("fgb:Directory is not configured.") ,
            environment.ContentRootPath);

        var file = Directory.GetFiles(dir, "*.json");
        
        if (file.Length == 0)
            return NotFound("No style file found in the FGB directory.");
        
        if (file.Length > 1)
            return BadRequest("Multiple style files found in the FGB directory. Only one is allowed.");
        
        return PhysicalFile(file[0], "application/json");
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
        
        return Export(layerId, (dataset, output) =>
            dataset.GetBytes(bbox, user.AuthPolygon, output));
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
        return Export(layerId, (dataset, output) =>
            dataset.FilterTextAttribute(attribute, value, output));
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
