using Microsoft.AspNetCore.Mvc;
using System.Net.Http.Headers;

namespace Flatserve.Fgb;

public sealed class MultipartFgbResult(IReadOnlyList<(string LayerId, byte[] Bytes)> layers) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        using var multipart = new MultipartContent("mixed");
        
        foreach (var (layerId, bytes) in layers)
        {
            var part = new ByteArrayContent(bytes);
            part.Headers.ContentType = new MediaTypeHeaderValue("application/vnd.fgb");
            part.Headers.ContentDisposition = new ContentDispositionHeaderValue("attachment")
            {
                FileName = "layer.fgb",
                FileNameStar = layerId + ".fgb"
            };
            multipart.Add(part);
        }

        var response = context.HttpContext.Response;
        response.ContentType = multipart.Headers.ContentType!.ToString();
        
        await multipart.CopyToAsync(response.Body, context.HttpContext.RequestAborted);
    }
}