using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using Sentinel.Api.Auth;
using Sentinel.Api.Data;
using Sentinel.Api.Endpoints;
using Sentinel.Api.Hubs;
using Sentinel.Api.Services;
using Sentinel.Api.Simulation;

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;

builder.Services.AddSingleton(new NpgsqlDataSourceBuilder(cfg.GetConnectionString("Postgres")!).Build());
builder.Services.AddSingleton<Db>();
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<PolicyStore>();
builder.Services.AddSingleton<AccessService>();
builder.Services.AddSingleton<AuditService>();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<DevCa>();
builder.Services.AddHostedService<DbSeeder>();
builder.Services.AddHostedService<EdgeSimulator>();
builder.Services.AddHostedService<FirmwareWorker>();

builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
builder.Services.AddSignalR().AddJsonProtocol(o => o.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidIssuer = cfg["Auth:Issuer"],
        ValidAudience = cfg["Auth:Audience"],
        IssuerSigningKey = TokenService.Key(cfg),
        NameClaimType = "name",
        ClockSkew = TimeSpan.FromSeconds(10),
    };
    // Browsers cannot set headers on WebSocket upgrades, so SignalR passes the token in the query string.
    o.Events = new JwtBearerEvents
    {
        OnMessageReceived = ctx =>
        {
            var token = ctx.Request.Query["access_token"];
            if (!string.IsNullOrEmpty(token) && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs")) ctx.Token = token;
            return Task.CompletedTask;
        },
    };
});
builder.Services.AddAuthorization();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(cfg.GetSection("Cors:Origins").Get<string[]>() ?? Array.Empty<string>())
     .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
var api = app.MapGroup("/api").RequireAuthorization();
api.MapAuth();
api.MapInventory();
api.MapOps();
app.MapHub<LiveHub>("/hubs/live");

app.Run();
