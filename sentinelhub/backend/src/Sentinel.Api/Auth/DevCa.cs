using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Sentinel.Api.Auth;

/// <summary>
/// Development issuing CA used by zero-touch provisioning (EST-style: device sends a PKCS#10 CSR, gets a cert back).
/// Production: replace with step-ca / ADCS / Vault PKI, an offline root and per-Edge sub-CAs.
/// </summary>
public sealed class DevCa : IDisposable
{
    private readonly X509Certificate2 _ca;

    public DevCa()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=SentinelHub Dev Issuing CA, O=SentinelHub", key, HashAlgorithmName.SHA256);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        using var tmp = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(5));
        // Round-trip so the private key is usable on every platform.
        _ca = X509CertificateLoader.LoadPkcs12(tmp.Export(X509ContentType.Pfx), null);
    }

    public string CaPem => _ca.ExportCertificatePem();

    public (string Pem, string Serial, DateTime NotAfter) IssueFromCsr(string csrPem, Guid deviceId, int days = 90)
    {
        var csr = CertificateRequest.LoadSigningRequestPem(csrPem, HashAlgorithmName.SHA256);
        csr.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        csr.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        csr.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid("1.3.6.1.5.5.7.3.2") /* clientAuth, 802.1X EAP-TLS */ }, false));
        var sanBuilder = new SubjectAlternativeNameBuilder();
        sanBuilder.AddUri(new Uri($"urn:sentinel:device:{deviceId}"));
        csr.CertificateExtensions.Add(sanBuilder.Build());

        var serial = RandomNumberGenerator.GetBytes(12);
        serial[0] &= 0x7F;
        var notAfter = DateTimeOffset.UtcNow.AddDays(days);
        using var cert = csr.Create(_ca, DateTimeOffset.UtcNow.AddMinutes(-5), notAfter, serial);
        return (cert.ExportCertificatePem(), Convert.ToHexString(serial), notAfter.UtcDateTime);
    }

    public void Dispose() => _ca.Dispose();
}
