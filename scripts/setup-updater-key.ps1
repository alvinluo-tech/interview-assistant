param([string]$KeyDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.mianxu/updater-signing'))
$ErrorActionPreference = 'Stop'
$keyRoot = [IO.Path]::GetFullPath($KeyDirectory)
$keyFile = Join-Path $keyRoot 'mianxu.key'
$passwordFile = Join-Path $keyRoot 'password.dpapi'
if ((Test-Path -LiteralPath $keyFile) -or (Test-Path -LiteralPath $passwordFile)) {
    throw 'Signing material already exists. Reuse and back up the existing key; do not rotate it automatically.'
}
New-Item -ItemType Directory -Path $keyRoot -Force | Out-Null
$acl = Get-Acl -LiteralPath $keyRoot
$acl.SetAccessRuleProtection($true, $false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $keyRoot -AclObject $acl
$keyPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$keyPassword | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $passwordFile
# The official generator only accepts a password argument; never print its output or password.
$cli = Join-Path $PSScriptRoot '../node_modules/@tauri-apps/cli/tauri.js'
& node $cli signer generate --ci --password $keyPassword --write-keys $keyFile *> (Join-Path $keyRoot 'generation.log')
if ($LASTEXITCODE -ne 0) { throw 'Signing-key generation failed; inspect the protected generation log locally.' }
$publicKey = (Get-Content -LiteralPath ($keyFile + '.pub') -Raw).Trim()
$publicFile = Join-Path $PSScriptRoot '../src-tauri/updater-public-key.txt'
[IO.File]::WriteAllText([IO.Path]::GetFullPath($publicFile), $publicKey + "`n")
$configFile = Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json'
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -AsHashtable
if (-not $config.ContainsKey('plugins')) { $config['plugins'] = @{} }
$config['plugins']['updater'] = @{
    pubkey = $publicKey
    endpoints = @('https://github.com/alvinluo-tech/interview-assistant/releases/latest/download/latest.json')
    requireSignedVersion = $true
    windows = @{ installMode = 'passive' }
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($configFile), ($config | ConvertTo-Json -Depth 30) + "`n")
$keyPassword = $null
Write-Output 'Created encrypted signing material outside the repository and saved only the public key in source. GitHub secrets have not been changed.'
