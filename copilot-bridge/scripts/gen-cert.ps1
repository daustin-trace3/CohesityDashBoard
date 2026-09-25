param(
  [Parameter(Mandatory = $true)][string]$PfxPath,
  [Parameter(Mandatory = $true)][string]$Password,
  [Parameter(Mandatory = $true)][string]$DnsNames
)

$ErrorActionPreference = 'Stop'

$names = $DnsNames.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$dir = Split-Path -Parent $PfxPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$cert = New-SelfSignedCertificate `
  -DnsName $names `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -NotAfter (Get-Date).AddYears(5) `
  -FriendlyName 'CopilotBridge'

$sec = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $sec | Out-Null

# Remove from the user cert store; the PFX file is the only copy we keep.
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force

Write-Output ("Generated {0} for: {1}" -f $PfxPath, ($names -join ', '))
