[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Label = 'test'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot 'package.json'
$distDir = Join-Path $repoRoot 'dist'
$archiveBase = Join-Path $repoRoot 'build\local-windows'

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Read-GitLines {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $lines = @(& git.exe @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "git.exe exited with code $LASTEXITCODE."
    }
    return $lines
}

Push-Location $repoRoot
try {
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw 'package.json was not found at the repository root.'
    }

    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $version = [string]$package.version
    $branch = (Read-GitLines @('branch', '--show-current') | Select-Object -First 1).Trim()
    $commit = (Read-GitLines @('rev-parse', '--short=12', 'HEAD') | Select-Object -First 1).Trim()
    $statusBeforeLines = @(Read-GitLines @('status', '--porcelain=v1', '--untracked-files=all'))
    $statusBefore = $statusBeforeLines -join "`n"
    $state = if ($statusBeforeLines.Count -gt 0) { 'dirty' } else { 'clean' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $buildId = "$version-$Label-$stamp-$commit-$state"
    $archiveDir = Join-Path $archiveBase $buildId
    $untrackedDir = Join-Path $archiveDir 'source-untracked'

    if (Test-Path -LiteralPath $archiveDir) {
        throw "Build archive already exists: $archiveDir"
    }
    [void](New-Item -ItemType Directory -Path $archiveDir -Force)
    $statusBefore | Set-Content -LiteralPath (Join-Path $archiveDir 'source-status.txt') -Encoding utf8NoBOM

    $patchPath = Join-Path $archiveDir 'source.patch'
    $patchProcess = Start-Process -FilePath 'git.exe' -ArgumentList @(
        'diff', '--binary', 'HEAD', '--'
    ) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $patchPath
    if ($patchProcess.ExitCode -ne 0) {
        throw "git.exe diff exited with code $($patchProcess.ExitCode)."
    }

    $untracked = @(Read-GitLines @('ls-files', '--others', '--exclude-standard'))
    foreach ($relativePath in $untracked) {
        if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
        $sourcePath = Join-Path $repoRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        $copyPath = Join-Path $untrackedDir $relativePath
        $copyParent = Split-Path -Parent $copyPath
        if (-not (Test-Path -LiteralPath $copyParent -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $copyParent -Force)
        }
        Copy-Item -LiteralPath $sourcePath -Destination $copyPath
    }

    $buildStartedAt = (Get-Date).ToUniversalTime()
    Invoke-Checked -FilePath 'npm.cmd' -Arguments @('run', 'dist:win')

    $installer = Join-Path $distDir "nodeterm-Setup-$version.exe"
    $appAsar = Join-Path $distDir 'win-unpacked\resources\app.asar'
    $sessionHost = Join-Path $distDir 'win-unpacked\resources\session-host\host.cjs'
    $codexRelay = Join-Path $repoRoot 'out\main\codex-relay.js'
    foreach ($required in @($installer, $appAsar, $sessionHost, $codexRelay)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required packaged file was not produced: $required"
        }
    }

    $statusAfter = @(Read-GitLines @('status', '--porcelain=v1', '--untracked-files=all')) -join "`n"
    if ($statusAfter -ne $statusBefore) {
        throw 'The workspace changed while packaging. Artifacts were left in dist, but this build was not archived as a reproducible handoff.'
    }

    $builtArtifacts = @(Get-ChildItem -LiteralPath $distDir -File | Where-Object {
        $_.LastWriteTimeUtc -ge $buildStartedAt.AddSeconds(-2) -and $_.Extension -in @('.exe', '.zip')
    })
    if ($builtArtifacts.Count -eq 0) {
        throw 'No Windows installer or zip artifact was produced.'
    }

    $artifactRecords = @()
    foreach ($artifact in $builtArtifacts) {
        $archivedPath = Join-Path $archiveDir $artifact.Name
        Copy-Item -LiteralPath $artifact.FullName -Destination $archivedPath
        $artifactRecords += [ordered]@{
            name = $artifact.Name
            path = $archivedPath
            size = (Get-Item -LiteralPath $archivedPath).Length
            sha256 = (Get-FileHash -LiteralPath $archivedPath -Algorithm SHA256).Hash
        }
    }

    $archivedInstaller = Join-Path $archiveDir (Split-Path -Leaf $installer)
    if (-not (Test-Path -LiteralPath $archivedInstaller -PathType Leaf)) {
        Copy-Item -LiteralPath $installer -Destination $archivedInstaller
        $artifactRecords += [ordered]@{
            name = Split-Path -Leaf $installer
            path = $archivedInstaller
            size = (Get-Item -LiteralPath $archivedInstaller).Length
            sha256 = (Get-FileHash -LiteralPath $archivedInstaller -Algorithm SHA256).Hash
        }
    }

    $manifest = [ordered]@{
        buildId = $buildId
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
        version = $version
        branch = $branch
        commit = $commit
        workspaceState = $state
        sourceStatus = 'source-status.txt'
        sourcePatch = 'source.patch'
        untrackedFiles = if ($untracked.Count -gt 0) { 'source-untracked' } else { $null }
        artifacts = $artifactRecords
        appAsarSha256 = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash
        sessionHostSha256 = (Get-FileHash -LiteralPath $sessionHost -Algorithm SHA256).Hash
        codexRelaySha256 = (Get-FileHash -LiteralPath $codexRelay -Algorithm SHA256).Hash
    }
    $manifestPath = Join-Path $archiveDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

    Write-Output "BUILD_ID=$buildId"
    Write-Output "ARCHIVE=$archiveDir"
    Write-Output "INSTALLER=$archivedInstaller"
    Write-Output "INSTALLER_SHA256=$((Get-FileHash -LiteralPath $archivedInstaller -Algorithm SHA256).Hash)"
    Write-Output "APP_ASAR_SHA256=$($manifest.appAsarSha256)"
    Write-Output "SESSION_HOST_SHA256=$($manifest.sessionHostSha256)"
    Write-Output "CODEX_RELAY_SHA256=$($manifest.codexRelaySha256)"
    Write-Output "RUN=Start-Process -FilePath `"$archivedInstaller`""
} finally {
    Pop-Location
}
