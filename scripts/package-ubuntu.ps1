<#
.SYNOPSIS
  Build an Ubuntu install package for the Infrastructure Command Center.

  Produces ..\icc-dashboard-<version>-<timestamp>.tar.gz containing the
  working tree (repo-relative paths), a fresh frontend/dist, and the deploy/
  installer. The same package does a fresh install or an upgrade on the host:

    scp ..\icc-dashboard-*.tar.gz user@host:/tmp/
    sudo bash -c 'mkdir -p /tmp/icc && tar -xzf /tmp/icc-dashboard-*.tar.gz -C /tmp/icc && bash /tmp/icc/deploy/install.sh'

  Never contains .env, frontend/.env.local, backend/data, backend/plugins,
  logs or node_modules. The installer runs npm ci on the host, so the host
  needs registry access unless you pass -WithDeps (see below).

.PARAMETER SkipBuild
  Reuse the existing frontend/dist instead of running vite build.

.PARAMETER BundleNode
  Download the latest Node <NodeMajor>.x linux-x64 tarball into node-runtime/
  inside the package so the installer never reaches nodejs.org.

.PARAMETER NodeMajor
  Node major line for -BundleNode. Default 24.

.PARAMETER WithDeps
  Path to a backend/node_modules tree that was produced on an Ubuntu host of
  the same major release (cd backend; npm ci --omit=dev). Vendors it into the
  package so the installer skips npm ci. Do NOT point this at the Windows
  node_modules; the native modules would not load.

.EXAMPLE
  .\scripts\package-ubuntu.ps1
.EXAMPLE
  .\scripts\package-ubuntu.ps1 -BundleNode -WithDeps \\hermes\tmp\node_modules
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$BundleNode,
  [int]$NodeMajor = 24,
  [string]$WithDeps = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ParentDir = Split-Path $RepoRoot -Parent
$FeDir     = Join-Path $RepoRoot 'frontend'
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$Version   = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
$OutFile   = Join-Path $ParentDir "icc-dashboard-$Version-$Stamp.tar.gz"
$Branch    = (git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)
$Commit    = (git -C $RepoRoot rev-parse --short HEAD 2>$null)

Write-Host "Repo: $RepoRoot ($Branch @ $Commit)"

# 1. Frontend build
if (-not $SkipBuild) {
  if (-not (Test-Path (Join-Path $FeDir 'node_modules\.bin\vite.cmd'))) {
    throw "vite not found in frontend/node_modules. Run 'npm install' in frontend/ first."
  }
  Write-Host 'Building frontend/dist'
  Push-Location $FeDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $FeDir 'dist\index.html'))) { throw 'frontend/dist/index.html missing.' }

# 2. Optional Node runtime bundle
$RuntimeDir = Join-Path $RepoRoot 'node-runtime'
if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
if ($BundleNode) {
  New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
  $base  = "https://nodejs.org/dist/latest-v$NodeMajor.x/"
  $sums  = (Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing).Content
  $fname = ($sums -split "`n" | ForEach-Object { ($_ -split '\s+')[-1] } |
            Where-Object { $_ -match "^node-v[\d.]+-linux-x64\.tar\.xz$" } | Select-Object -First 1)
  if (-not $fname) { throw "Could not resolve a Node $NodeMajor.x linux-x64 tarball." }
  Write-Host "Downloading $fname"
  Invoke-WebRequest -Uri ($base + $fname) -OutFile (Join-Path $RuntimeDir $fname) -UseBasicParsing
}

# 3. Optional vendored deps built on Ubuntu
$VendorDir = Join-Path $RepoRoot 'backend\node_modules.ubuntu'
if (Test-Path $VendorDir) { Remove-Item $VendorDir -Recurse -Force }
if ($WithDeps) {
  if (-not (Test-Path (Join-Path $WithDeps 'better-sqlite3\package.json'))) {
    throw "-WithDeps path does not look like a backend/node_modules tree: $WithDeps"
  }
  $linuxBuild = Get-ChildItem (Join-Path $WithDeps 'better-sqlite3\build') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $linuxBuild) { throw '-WithDeps tree has no compiled better-sqlite3 binary; build it on Ubuntu first.' }
  Write-Host "Vendoring deps from $WithDeps"
  Copy-Item $WithDeps $VendorDir -Recurse
}

# 4. Collect files. Working tree, not HEAD, so uncommitted fixes ship.
$excludeDirNames = @('node_modules', 'logs', '.git', '.agents', '.gstack', 'node_modules.ubuntu')
$excludePaths    = @('backend/data', 'backend/plugins', 'frontend/node_modules')
$excludeGlobs    = @('.env', '.env.local', '*.db', '*.db-shm', '*.db-wal', '*.sqlite', '*.sqlite3', '*.iccplugin', '*.tar.gz')

function Test-Excluded {
  param([string]$RelPath)
  $n = ($RelPath -replace '\\', '/')
  if ($n.StartsWith('node-runtime/')) { return $false }
  if ($n.StartsWith('backend/node_modules.ubuntu/')) { return $false }
  foreach ($seg in ($RelPath -split '[\\/]')) { if ($excludeDirNames -contains $seg) { return $true } }
  foreach ($p in $excludePaths) { if ($n -eq $p -or $n.StartsWith("$p/")) { return $true } }
  $leaf = Split-Path $RelPath -Leaf
  foreach ($g in $excludeGlobs) { if ($leaf -like $g) { return $true } }
  return $false
}

Push-Location $RepoRoot
try {
  $files = Get-ChildItem -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('\', '/')
    if (-not (Test-Excluded $rel)) {
      # Vendored deps ride in the tarball at backend/node_modules/ so the
      # installer's "vendored" branch finds them.
      ($rel -replace '\\', '/') -replace '^backend/node_modules\.ubuntu/', 'backend/node_modules/'
    }
  }
  if (-not $files) { throw 'No files matched for packaging.' }

  # Record what shipped.
  $manifest = @(
    "version=$Version", "branch=$Branch", "commit=$Commit",
    "built=$(Get-Date -Format o)", "bundle_node=$($BundleNode.IsPresent)", "vendored_deps=$([bool]$WithDeps)"
  )
  [System.IO.File]::WriteAllText((Join-Path $RepoRoot 'PACKAGE-INFO'), (($manifest -join "`n") + "`n"))
  $files += 'PACKAGE-INFO'

  $listFile = Join-Path $env:TEMP "icc-pkg-$Stamp.txt"
  if ($WithDeps) {
    # tar reads paths as stored on disk; map the vendored tree back for reading
    # and rename on the fly with --transform.
    $onDisk = $files | ForEach-Object { $_ -replace '^backend/node_modules/', 'backend/node_modules.ubuntu/' }
    [System.IO.File]::WriteAllText($listFile, (($onDisk -join "`n") + "`n"))
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    tar -czf $OutFile -s '|^backend/node_modules\.ubuntu/|backend/node_modules/|' -T $listFile
  } else {
    [System.IO.File]::WriteAllText($listFile, (($files -join "`n") + "`n"))
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    tar -czf $OutFile -T $listFile
  }
  if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
  Remove-Item $listFile -Force -ErrorAction SilentlyContinue
}
finally {
  Pop-Location
  Remove-Item (Join-Path $RepoRoot 'PACKAGE-INFO') -Force -ErrorAction SilentlyContinue
  if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
  if (Test-Path $VendorDir)  { Remove-Item $VendorDir -Recurse -Force }
}

$sizeMB  = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
$pkgName = Split-Path $OutFile -Leaf
Write-Host ''
Write-Host "Created $OutFile ($sizeMB MB, $($files.Count) files)" -ForegroundColor Green
Write-Host ''
Write-Host 'On the Ubuntu host:' -ForegroundColor Cyan
Write-Host "  scp `"$OutFile`" user@host:/tmp/"
Write-Host "  sudo bash -c 'rm -rf /tmp/icc && mkdir -p /tmp/icc && tar -xzf /tmp/$pkgName -C /tmp/icc && bash /tmp/icc/deploy/install.sh'"
Write-Host '  (add --license-key CDBL-... --trust-proxy 1 --port 3001 as needed; run again with a newer package to upgrade)'
