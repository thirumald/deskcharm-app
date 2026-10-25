FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY src/Sentinel.Core/ src/Sentinel.Core/
COPY src/Sentinel.Api/ src/Sentinel.Api/
RUN dotnet publish src/Sentinel.Api/Sentinel.Api.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Sentinel.Api.dll"]
