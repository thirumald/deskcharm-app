using Dapper;
using Npgsql;

namespace Sentinel.Api.Data;

/// <summary>Thin Dapper wrapper over the pooled Npgsql data source.</summary>
public sealed class Db(NpgsqlDataSource source)
{
    static Db() => DefaultTypeMap.MatchNamesWithUnderscores = true;

    public NpgsqlDataSource Source => source;

    public async Task<List<T>> QueryAsync<T>(string sql, object? args = null, CancellationToken ct = default)
    {
        await using var conn = await source.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct))).ToList();
    }

    public async Task<T?> QueryFirstOrDefaultAsync<T>(string sql, object? args = null, CancellationToken ct = default)
    {
        await using var conn = await source.OpenConnectionAsync(ct);
        return await conn.QueryFirstOrDefaultAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    public async Task<T?> ScalarAsync<T>(string sql, object? args = null, CancellationToken ct = default)
    {
        await using var conn = await source.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    public async Task<int> ExecuteAsync(string sql, object? args = null, CancellationToken ct = default)
    {
        await using var conn = await source.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    /// <summary>SQL predicate that applies an RBAC <see cref="Sentinel.Core.Rbac.Scope"/> to an ltree column. Bind @allow and @deny.</summary>
    public static string ScopeSql(string column) =>
        $"({column} <@ ANY(@allow::text[]::ltree[]) AND NOT {column} <@ ANY(@deny::text[]::ltree[]))";
}
