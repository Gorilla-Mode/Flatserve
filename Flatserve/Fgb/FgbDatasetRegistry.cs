namespace Flatserve.Fgb;

public sealed class FgbDatasetRegistry
{
    private readonly Dictionary<string, FgbLayer> _datasets = new(StringComparer.OrdinalIgnoreCase);
    public IReadOnlyDictionary<string, FgbLayer> Datasets => _datasets;

    public FgbDatasetRegistry(IConfiguration configuration, IWebHostEnvironment environment, ILoggerFactory loggerFactory, MetricsWriter metrics)
    {
        string Resolve(string path) => Path.GetFullPath(path, environment.ContentRootPath);

        var directory = configuration["Fgb:Directory"];
        var singleFile = configuration["Fgb:Path"];
        var paths = directory is null && singleFile is not null
            ? new[] { Resolve(singleFile) }
            : Directory.GetFiles(Resolve(directory ?? Path.Combine("test", "fgb")))
                .Where(path => Path.GetExtension(path).Equals(".fgb", StringComparison.OrdinalIgnoreCase))
                .OrderBy(Path.GetFileName, StringComparer.Ordinal).ToArray();

        if (paths.Length == 0)
            throw new InvalidOperationException("The configured FGB directory contains no .fgb files.");

        var attributes = configuration.GetSection("Fgb:TextIndexes").Get<string[]>();
        
        var logger = loggerFactory.CreateLogger<FgbDataset>();

        FgbDataset Load(string path) => new(path, logger, metrics, attributes);

        foreach (var path in paths)
        {
            var layerId = Path.GetFileNameWithoutExtension(path);

            if (Path.GetExtension(layerId) is ".lod1" or ".lod2" or ".lod3")
                continue;

            FgbDataset? LoadLod(int level)
            {
                var lodPath = Path.ChangeExtension(path, $".lod{level}.fgb");
                return File.Exists(lodPath) ? Load(lodPath) : null;
            }

            _datasets.Add(layerId, new FgbLayer(
                Load(path),
                LoadLod(1),
                LoadLod(2),
                LoadLod(3)));
        }
    }
}