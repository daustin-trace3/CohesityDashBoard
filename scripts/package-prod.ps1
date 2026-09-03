<#
.SYNOPSIS
  ONE-COMMAND offline-prod package builder (self-contained; no middle box).

  Produces a single ..\cohesity-update-<timestamp>.tar.gz on THIS Windows box
  containing everything prod needs, then you just:
    scp it to prod  ->  dzdo bash /opt/cohesity-dashboard/deploy/update.sh <pkg>

  The package contains:
    * the application source overlay (incl. any uncommitted migration fixes),
    * frontend/dist (rebuilt; session/cookie auth so no baked key needed), and
    * the NEW PURE-JS backend runtime deps (fast-xml-parser, multer, nodemailer,
      yauzl + transitive closure) so offline prod never runs npm install.
  It NEVER contains .env, .env.local, backend/data, or NATIVE modules
  (better-sqlite3, argon2) - those must be compiled ON the RHEL target and are
  left as prod's own copies. The DB self-migrates (idempotently) on restart.

.PARAMETER Roots
  Top-level backend deps whose runtime closure is vendored. Default = the deps
  added on the auth/RBAC branch plus the @aws-sdk/client-* clients. better-sqlite3
  and argon2 are always excluded (native; compiled on the RHEL target).

.PARAMETER BackendOnly
  Source overlay + deps only. Skips the frontend rebuild and the key prompt.

.PARAMETER SinceRef
  Git ref for the previously-deployed state (reserved; frontend is rebuilt by
  default unless -BackendOnly). Default 'HEAD@{1}'.

.PARAMETER ProdHost
  Hostname shown in the copy/apply hint at the end. Cosmetic only.

.EXAMPLE
  .\scripts\package-prod.ps1
  Full package: rebuild frontend (prompts for prod key) + overlay + deps.

.EXAMPLE
  .\scripts\package-prod.ps1 -BackendOnly
  Backend-only push, no key prompt.
#>
[CmdletBinding()]
param(
  # argon2 (native) is auto-excluded from cross-shipping. fast-xml-parser is
  # intentionally NOT vendored - it already exists on prod and we don't want to
  # overwrite it. The @aws-sdk/client-* roots are pure JS and safe to cross-ship
  # Windows -> RHEL.
  [string[]]$Roots = @(
    'argon2', 'multer', 'nodemailer', 'yauzl',
    '@aws-sdk/client-cloudwatch', '@aws-sdk/client-compute-optimizer',
    '@aws-sdk/client-cost-explorer', '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-ec2', '@aws-sdk/client-ecr', '@aws-sdk/client-ecs',
    '@aws-sdk/client-lambda', '@aws-sdk/client-lightsail',
    '@aws-sdk/client-rds', '@aws-sdk/client-s3'
  ),
  [switch]$BackendOnly,
  [string]$SinceRef = 'HEAD@{1}',
  [string]$ProdHost = 'x285410'
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ParentDir = Split-Path $RepoRoot -Parent
$Nm        = Join-Path $RepoRoot 'backend/node_modules'
$FeDir     = Join-Path $RepoRoot 'frontend'
$EnvLocal  = Join-Path $FeDir '.env.local'
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutFile   = Join-Path $ParentDir "cohesity-update-$Stamp.tar.gz"

# ------------------------------------------------------------------------
# 1. Compute the runtime dependency closure of $Roots.
#    -IncludeDeps whitelists the ENTIRE backend/node_modules/<name>/ subtree,
#    so nested node_modules ride along inside their parent. We only need every
#    name in the closure; redundant (nested-only) names are harmless.
# ------------------------------------------------------------------------
function Get-DepClosure {
  param([string[]]$RootNames)
  $seen    = New-Object 'System.Collections.Generic.HashSet[string]'
  $missing = New-Object 'System.Collections.Generic.List[string]'
  $stack   = New-Object 'System.Collections.Generic.Stack[object]'
  foreach ($r in $RootNames) { $stack.Push([pscustomobject]@{ Name = $r; From = $RepoRoot }) }
  while ($stack.Count -gt 0) {
    $item = $stack.Pop()
    $name = $item.Name
    if ($seen.Contains($name)) { continue }
    $dir = Join-Path $item.From "node_modules/$name"
    if (-not (Test-Path (Join-Path $dir 'package.json'))) { $dir = Join-Path $Nm $name }
    if (-not (Test-Path (Join-Path $dir 'package.json'))) {
      if (-not $missing.Contains($name)) { $missing.Add($name) }
      continue
    }
    [void]$seen.Add($name)
    $pj = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
    if ($pj.PSObject.Properties.Name -contains 'dependencies' -and $pj.dependencies) {
      foreach ($dep in $pj.dependencies.PSObject.Properties.Name) {
        $stack.Push([pscustomobject]@{ Name = $dep; From = $dir })
      }
    }
  }
  return [pscustomobject]@{ Deps = @($seen | Sort-Object); Missing = @($missing) }
}

Write-Host "Repo: $RepoRoot"
Write-Host "Resolving dependency closure for: $($Roots -join ', ')"
$closure     = Get-DepClosure -RootNames $Roots
$includeDeps = $closure.Deps

if ($closure.Missing.Count -gt 0) {
  Write-Warning ("Not installed locally (skipped): " + ($closure.Missing -join ', '))
  Write-Warning "Run 'cd backend; npm install' first if they should be included."
}
if ($includeDeps.Count -eq 0) {
  throw "No dependency folders resolved. Wrong branch, or 'npm install' not run in backend/?"
}

# Native modules must be compiled ON the RHEL target - never cross-shipped from
# Windows. better-sqlite3 has no compatible prebuilt; argon2 DOES ship a linux-x64
# prebuilt but it targets glibc 2.34+ and will NOT load on RHEL 8 (glibc 2.28) -
# it fails at require with "GLIBC_2.34 not found". Both are excluded so prod keeps
# its own compiled copy (update.sh preserves node_modules). Compile once on prod:
#   cd /opt/cohesity-dashboard/backend
#   dzdo rm -rf node_modules/argon2/prebuilds
#   dzdo env npm_config_nodedir=/opt/node-v26.5.0-linux-x64 npm rebuild argon2
#   dzdo systemctl restart cohesity-dashboard cohesity-poller
$nativeExclude  = @('better-sqlite3', 'argon2')
$excludedNative = @($includeDeps | Where-Object { $nativeExclude -contains $_ })
if ($excludedNative.Count -gt 0) {
  $includeDeps = @($includeDeps | Where-Object { $nativeExclude -notcontains $_ })
  Write-Warning ("Excluded native deps (compile on prod, do NOT cross-ship): " + ($excludedNative -join ', '))
  if ($excludedNative -contains 'argon2') {
    Write-Warning "argon2 is native. First deploy only: on prod run 'dzdo rm -rf node_modules/argon2/prebuilds; dzdo env npm_config_nodedir=/opt/node-v26.5.0-linux-x64 npm rebuild argon2' then restart the services. Its compiled copy then persists across future updates."
  }
}

Write-Host ("Vendoring {0} dependency folders." -f $includeDeps.Count)
Write-Host ("  " + ($includeDeps -join ', ')) -ForegroundColor DarkGray
Write-Host ""

Push-Location $RepoRoot
try {
  # ----------------------------------------------------------------------
  # 2. Decide whether to (re)build the frontend.
  # ----------------------------------------------------------------------
  $frontendChanged = -not $BackendOnly   # default: include a fresh, key-baked dist
  Write-Host "Frontend rebuild: $frontendChanged  (key needed only when true)"
  Write-Host ""

  # ----------------------------------------------------------------------
  # 3. Build frontend/dist.
  #    Older builds baked DASHBOARD_API_KEY into the bundle (Vite
  #    VITE_DASHBOARD_API_KEY) and needed prod's key at build time. The auth/RBAC
  #    branch uses SESSION/COOKIE auth instead (no baked key), so we auto-detect:
  #    only prompt for + bake a key when the source actually references it.
  # ----------------------------------------------------------------------
  $envBackup = $null
  if ($frontendChanged) {
    if (-not (Test-Path (Join-Path $FeDir 'node_modules\.bin\vite.cmd')) -and
        -not (Test-Path (Join-Path $FeDir 'node_modules\.bin\vite'))) {
      throw "vite not found in frontend/node_modules. Run 'npm install' in frontend/ first."
    }

    $usesBakedKey = $null -ne (Get-ChildItem (Join-Path $FeDir 'src') -Recurse -File -Include *.js, *.jsx, *.ts, *.tsx -ErrorAction SilentlyContinue |
      Select-String -SimpleMatch -Pattern 'VITE_DASHBOARD_API_KEY' -List | Select-Object -First 1)

    if ($usesBakedKey) {
      Write-Host "Frontend bakes an API key at build time. Reuse PROD's CURRENT key so nothing changes on prod." -ForegroundColor Yellow
      Write-Host "Read it on prod: dzdo grep '^DASHBOARD_API_KEY=' /opt/cohesity-dashboard/.env" -ForegroundColor Yellow
      $sec = Read-Host 'Paste PROD DASHBOARD_API_KEY (hidden)' -AsSecureString
      $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
               [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      if ([string]::IsNullOrWhiteSpace($key)) { throw 'No key entered - aborting.' }

      if (Test-Path $EnvLocal) {
        $envBackup = "$EnvLocal.bak-$Stamp"
        Copy-Item $EnvLocal $envBackup -Force
      }
      try {
        Set-Content -Path $EnvLocal -Value "VITE_DASHBOARD_API_KEY=$key" -NoNewline -Encoding ascii
        Push-Location $FeDir
        try {
          npm run build
          if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)" }
        }
        finally { Pop-Location }

        if (-not (Test-Path (Join-Path $FeDir 'dist'))) { throw 'Build produced no dist/ folder.' }

        $baked = $false
        foreach ($js in (Get-ChildItem (Join-Path $FeDir 'dist') -Recurse -Filter *.js)) {
          if (Select-String -Path $js.FullName -SimpleMatch -Pattern $key -Quiet) { $baked = $true; break }
        }
        if (-not $baked) { throw 'Key was NOT found in the built bundle.' }
        $fp = if ($key.Length -ge 10) { "$($key.Substring(0,6))...$($key.Substring($key.Length-4))" } else { '(short)' }
        Write-Host "Verified key baked into dist. Fingerprint: $fp (must match prod's DASHBOARD_API_KEY)" -ForegroundColor Green
      }
      finally {
        if ($envBackup) { Move-Item $envBackup $EnvLocal -Force }
        elseif (Test-Path $EnvLocal) { Remove-Item $EnvLocal -Force }
      }
    }
    else {
      Write-Host "Frontend uses session/cookie auth (no baked key). Plain build - no key prompt." -ForegroundColor Green
      Push-Location $FeDir
      try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)" }
      }
      finally { Pop-Location }
      if (-not (Test-Path (Join-Path $FeDir 'dist'))) { throw 'Build produced no dist/ folder.' }
      Write-Host "Built frontend/dist." -ForegroundColor Green
    }
  }

  # ----------------------------------------------------------------------
  # 4. Collect files for the overlay (working tree, repo-relative paths).
  # ----------------------------------------------------------------------
  $excludeDirNames = @('node_modules', 'logs', '.git', '.agents', '.gstack')
  $excludePaths    = @('backend/data')
  $excludeGlobs    = @('.env', '.env.local', '*.db', '*.sqlite', '*.sqlite3')

  function Test-Excluded {
    param([string]$RelPath)
    $n = ($RelPath -replace '\\', '/')
    # Whitelist requested backend/node_modules/<dep> subtrees BEFORE the generic
    # node_modules exclusion below.
    foreach ($dep in $includeDeps) {
      $depPath = "backend/node_modules/$dep"
      if ($n -eq $depPath -or $n.StartsWith("$depPath/")) { return $false }
    }
    $segments = $RelPath -split '[\\/]'
    foreach ($seg in $segments) { if ($excludeDirNames -contains $seg) { return $true } }
    foreach ($p in $excludePaths) { if ($n -eq $p -or $n.StartsWith("$p/")) { return $true } }
    if (($n -eq 'frontend/dist' -or $n.StartsWith('frontend/dist/')) -and -not $frontendChanged) { return $true }
    $leaf = Split-Path $RelPath -Leaf
    foreach ($g in $excludeGlobs) { if ($leaf -like $g) { return $true } }
    return $false
  }

  $files = Get-ChildItem -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('\', '/')
    if (-not (Test-Excluded $rel)) { ($rel -replace '\\', '/') }
  }
  if (-not $files -or $files.Count -eq 0) { throw 'No files matched for packaging.' }

  $depFileCount = @($files | Where-Object { $_ -like 'backend/node_modules/*' }).Count

  $listFile = Join-Path $env:TEMP "cohesity-upd-$Stamp.txt"
  [System.IO.File]::WriteAllText($listFile, (($files -join "`n") + "`n"))

  if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
  tar -czf $OutFile -T $listFile
  if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
  Remove-Item $listFile -Force -ErrorAction SilentlyContinue
}
finally {
  Pop-Location
}

$sizeMB  = [math]::Round((Get-Item $OutFile).Length / 1MB, 2)
$pkgName = Split-Path $OutFile -Leaf
Write-Host ""
Write-Host "Created $OutFile" -ForegroundColor Green
Write-Host ("  $sizeMB MB, $($files.Count) files, $depFileCount dep files, frontend=$frontendChanged")
Write-Host ""
Write-Host "Apply on prod (secrets, DB, and better-sqlite3 untouched):" -ForegroundColor Cyan
Write-Host "  scp `"$OutFile`" user@${ProdHost}:/tmp/"
Write-Host "  dzdo bash /opt/cohesity-dashboard/deploy/update.sh /tmp/$pkgName"
