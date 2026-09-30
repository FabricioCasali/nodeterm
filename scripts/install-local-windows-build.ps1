[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$ExpectedInstallerHash,
    [Parameter(Mandatory)][string]$ExpectedAsarHash,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [string]$ArchitectNode,
    [ValidateRange(0, 300)][int]$DelaySeconds = 60,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\node-terminal'
$exe = Join-Path $installDir 'nodeterm.exe'
$asar = Join-Path $installDir 'resources\app.asar'
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Installer not found.' }
if (-not (Test-Path -LiteralPath $installDir -PathType Container)) { throw 'Installed application directory not found.' }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $ReceiptPath) -PathType Container)) { throw 'Receipt parent directory not found.' }
if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ne $ExpectedInstallerHash) { throw 'Installer hash mismatch.' }
if ($ExpectedAsarHash -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid expected application hash.' }
if ($ArchitectNode -and $ArchitectNode -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid architect node id.' }
function Test-PersistentHostRunning {
    $statePath = Join-Path $env:APPDATA 'node-terminal\session-host.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
    # Fail closed on an unreadable ownership record, before closing any application window.
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if (-not $state.pid -or [int]$state.pid -le 0) { throw 'Persistent host state is invalid; installation was not started.' }
    return $null -ne (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)
}
if ($ValidateOnly) {
    [pscustomobject]@{ Validation = 'passed'; Installer = $Installer; InstallDirectory = $installDir; ReadyToInstall = -not (Test-PersistentHostRunning) }
    return
}

$receipt = [ordered]@{ state = 'scheduled'; startedAt = (Get-Date).ToUniversalTime().ToString('o'); installer = $Installer }
function Save-Receipt {
    # One writer, private operational receipt; never contains credentials or command arguments.
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
}
function Get-AppProcesses {
    @(Get-Process -Name nodeterm -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -eq $exe } catch { $false }
    })
}
Save-Receipt
try {
    Start-Sleep -Seconds $DelaySeconds
    if (Test-PersistentHostRunning) {
        throw 'The persistent terminal host is still running. Coordinate session completion and host retirement before installing; no window or session was closed.'
    }
    $receipt.state = 'closing'
    Save-Receipt
    foreach ($process in (Get-AppProcesses)) {
        if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(45)
    while (@(Get-AppProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    if (@(Get-AppProcesses).Count -gt 0) {
        throw 'Nodeterm did not close gracefully. Close it through Exit; no process was forced.'
    }
    $receipt.state = 'installing'
    Save-Receipt
    $setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    $receipt.installerExitCode = $setup.ExitCode
    if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
    $actualHash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
    $receipt.installedAsarHash = $actualHash
    if ($actualHash -ne $ExpectedAsarHash) { throw 'Installed application hash does not match the built artifact.' }
    $receipt.state = 'installed'
    Save-Receipt
    $env:ELECTRON_RUN_AS_NODE = $null
    if (@(Get-AppProcesses).Count -eq 0) { Start-Process -FilePath $exe }
    $receipt.state = 'reopened'
    Save-Receipt
    if ($ArchitectNode -and $env:NODETERM_NODE_ID -and $env:NODETERM_CANVAS_CONTROL) {
        Start-Sleep -Seconds 20
        $shim = Join-Path $env:APPDATA 'node-terminal\canvas-control\nodeterm.sh'
        # Use the documented authenticated route, once. A refusal is recorded, never bypassed.
        $result = & sh $shim send --node $ArchitectNode --text 'TESTE DE COMUNICACAO NATIVA WINDOWS: responda NT_PONG_WINDOWS usando nodeterm reply para o reply-to desta mensagem. Nao altere arquivos nem inicie implementacao; este turno verifica somente entrega e retorno.' 2>&1
        $receipt.messageAttempt = ($result | Out-String).Trim()
    }
    $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Receipt
} catch {
    $receipt.state = 'failed'
    $receipt.error = $_.Exception.Message
    $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Receipt
    throw
}
