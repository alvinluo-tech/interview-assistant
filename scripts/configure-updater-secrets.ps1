param(
    [string]$KeyDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.mianxu/updater-signing'),
    [string]$GitHubCli = 'gh',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$repository = 'alvinluo-tech/interview-assistant'
$keyRoot = [IO.Path]::GetFullPath($KeyDirectory)
$privateFile = Join-Path $keyRoot 'mianxu.key'
$passwordFile = Join-Path $keyRoot 'password.dpapi'
$publicKey = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src-tauri/updater-public-key.txt') -Raw).Trim()
$localPublic = (Get-Content -LiteralPath ($privateFile + '.pub') -Raw).Trim()
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if ($publicKey -ne $localPublic -or $publicKey -ne $config.plugins.updater.pubkey) { throw 'Public keys do not match. Do not upload or rotate signing secrets.' }
if (-not (Test-Path -LiteralPath $privateFile) -or -not (Test-Path -LiteralPath $passwordFile)) { throw 'Existing signing material is incomplete.' }
if (-not $Apply) {
    Write-Output "Preflight passed for $repository. No remote changes. With explicit approval, use -Apply to set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
    return
}
$ghPath = (Get-Command $GitHubCli -ErrorAction Stop).Source
function Set-RepositorySecret([string]$Name, [string]$Value) {
    # Only secret names are arguments. Values go through stdin, never logs/argv.
    $start = [Diagnostics.ProcessStartInfo]::new($ghPath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    foreach ($argument in @('secret', 'set', $Name, '--repo', $repository)) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.Write($Value)
        $process.StandardInput.Close()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Failed to configure $Name; do not publish a release until both secrets are configured." }
    } finally { $process.Dispose() }
}
$secure = (Get-Content -LiteralPath $passwordFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    Set-RepositorySecret 'TAURI_SIGNING_PRIVATE_KEY' (Get-Content -LiteralPath $privateFile -Raw).Trim()
    Set-RepositorySecret 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' $password
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $password = $null
    $secure.Dispose()
}
Write-Output 'Configured both updater signing secrets. No source was pushed and no release was published.'
