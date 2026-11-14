using System.Diagnostics;
using Flatserve.Fgb;
using Flatserve.User;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().WithMethods("GET").WithHeaders("Accept")));
builder.Services.AddSingleton<FgbDatasetRegistry>();

builder.Services.AddSingleton<UserCollection>();

// Agder
UserCollection.AddUser(new User
{
    id = 0,
    AuthPolygon = UserCollection.G.CreatePolygon([
        new(6.15, 58.30),
        new(6.70, 58.00),
        new(7.50, 57.90),
        new(8.30, 58.10),
        new(9.50, 58.75),
        new(9.10, 59.10),
        new(8.00, 59.75),
        new(7.20, 59.65),
        new(6.50, 59.15),
        new(6.15, 58.30)
    ])
});

// Oslo
UserCollection.AddUser(new User
{
    id = 1,
    AuthPolygon = UserCollection.G.CreatePolygon([
        new(10.60, 59.87),
        new(10.70, 59.83),
        new(10.83, 59.85),
        new(10.95, 59.95),
        new(10.90, 60.05),
        new(10.75, 60.14),
        new(10.55, 60.10),
        new(10.48, 59.98),
        new(10.60, 59.87)
    ])
});

// Norway
UserCollection.AddUser(new User
{
    id = 2,
    AuthPolygon = UserCollection.G.CreatePolygon([
        new(4.0, 57.5),
        new(32.0, 57.5),
        new(32.0, 71.5),
        new(4.0, 71.5),
        new(4.0, 57.5)
    ])
});


var app = builder.Build();

var gcLogGate = new object();
var lastGcIndex = GC.GetGCMemoryInfo().Index;

using var gcTimer = new Timer(_ =>
{
    lock (gcLogGate)
    {
        var gc = GC.GetGCMemoryInfo();

        if (gc.Index == lastGcIndex)
            return;

        lastGcIndex = gc.Index;

        foreach (var pause in gc.PauseDurations)
        {
            if (pause == TimeSpan.Zero)
                continue;

            app.Logger.LogInformation(
                "\u001b[91mGC {Index}, generation {Generation}: pause {PauseUs:F3} µs\u001b[0m",
                gc.Index,
                gc.Generation,
                pause.TotalMicroseconds);
        }

        app.Logger.LogInformation(
            "\u001b[91mTotal GC pause time: {TotalMs:F3} ms\u001b[0m",
            GC.GetTotalPauseDuration().TotalMilliseconds);
    }
}, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

app.Use(async (context, next) =>
{
    var started = Stopwatch.GetTimestamp();

    context.Response.OnCompleted(() =>
    {
        var elapsed = Stopwatch.GetElapsedTime(started);

        app.Logger.LogInformation(
            "Request {RequestId}: {Method} {Path} returned {StatusCode} in {ElapsedMs:F3} ms",
            context.TraceIdentifier,
            context.Request.Method,
            context.Request.Path,
            context.Response.StatusCode,
            elapsed.TotalMilliseconds);

        return Task.CompletedTask;
    });

    await next(context);
});


// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// Match the public CORS policy so cross-origin clients can measure the HTTP exchange.
app.Use(async (context, next) =>
{
    context.Response.Headers["Timing-Allow-Origin"] = "*";
    await next(context);
});

app.UseCors();

app.UseHttpsRedirection();

app.UseAuthorization();

app.MapControllers();

app.Run();
