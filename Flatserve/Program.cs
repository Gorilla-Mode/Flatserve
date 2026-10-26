using Flatserve.Fgb;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().WithMethods("GET").WithHeaders("Accept")));
builder.Services.AddSingleton(
    new FgbDataset(builder.Configuration["Fgb:Path"] ?? Path.Combine(
        builder.Environment.ContentRootPath, "test", "fgb",
        "Samfunnssikkerhet_0000_Norge_25833_Brannstasjoner_GML.fgb")));

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseCors();

app.UseHttpsRedirection();

app.UseAuthorization();

app.MapControllers();

app.Run();
