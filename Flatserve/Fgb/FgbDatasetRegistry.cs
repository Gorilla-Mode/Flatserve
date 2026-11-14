namespace Flatserve.Fgb;

public sealed class FgbDatasetRegistry
{
    private readonly Dictionary<string, FgbDataset> _datasets = new(StringComparer.OrdinalIgnoreCase);
    public IReadOnlyDictionary<string, FgbDataset> Datasets => _datasets;

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
        
        foreach (var path in paths)
        {
            var id = Path.GetFileNameWithoutExtension(path);
            if (string.IsNullOrWhiteSpace(id) || _datasets.ContainsKey(id))
                throw new InvalidOperationException($"Invalid or duplicate FGB layer ID: '{id}'.");
            try
            {
                _datasets.Add(id, new FgbDataset(path, loggerFactory.CreateLogger<FgbDataset>(), metrics, attributes));
            }
            catch (Exception exception)
            {
                throw new InvalidOperationException($"Unable to load FGB layer '{id}' from '{path}'.", exception);
            }
        }
    }
}