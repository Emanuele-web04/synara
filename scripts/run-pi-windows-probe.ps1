param(
  [string]$AssetsDirectory = 'release-publish',
  [Parameter(Mandatory=$true)][string]$ProbePath,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
$installers = @(Get-ChildItem -LiteralPath $AssetsDirectory -File -Filter '*.exe')
if ($installers.Count -ne 1) { throw "Expected one Windows installer, found $($installers.Count)" }
$probe = (Resolve-Path -LiteralPath $ProbePath).Path
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$evidence = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('Synara packaged Pi ' + [guid]::NewGuid().ToString('N'))
$installerRoot = Join-Path $root 'installer'
$appRoot = Join-Path $root 'application'
New-Item -ItemType Directory -Force -Path $installerRoot,$appRoot | Out-Null
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$previousNodeOptions = $env:NODE_OPTIONS
$previousNodePath = $env:NODE_PATH
$previousLocalControl = $env:SYNARA_PROBE_LOCAL_CONTROL
try {
  & 7z x -y "-o$installerRoot" $installers[0].FullName | Out-File -Encoding utf8 (Join-Path $evidence 'extract-installer.log')
  if ($LASTEXITCODE -ne 0) { throw "Installer extraction failed: $LASTEXITCODE" }
  $payloads = @(Get-ChildItem -LiteralPath $installerRoot -Recurse -File | Where-Object { $_.Name -match '^app-(32|64|arm64)\.7z$' })
  if ($payloads.Count -ne 1) { throw "Expected one NSIS payload, found $($payloads.Count)" }
  & 7z x -y "-o$appRoot" $payloads[0].FullName | Out-File -Encoding utf8 (Join-Path $evidence 'extract-payload.log')
  if ($LASTEXITCODE -ne 0) { throw "Payload extraction failed: $LASTEXITCODE" }
  $executables = @(Get-ChildItem -LiteralPath $appRoot -Recurse -File | Where-Object { $_.Name -match '^Synara[^\\/]*\.exe$' })
  if ($executables.Count -ne 1) { throw "Expected one Synara executable, found $($executables.Count)" }
  $archive = Join-Path $executables[0].DirectoryName 'resources/app.asar'
  if (!(Test-Path -LiteralPath $archive)) { throw 'Missing app.asar' }
  $env:ELECTRON_RUN_AS_NODE = '1'
  Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH,Env:SYNARA_PROBE_LOCAL_CONTROL -ErrorAction SilentlyContinue
  & $executables[0].FullName $probe $archive *>&1 | Tee-Object -FilePath (Join-Path $evidence 'pi-and-compaction.log')
  if ($LASTEXITCODE -ne 0) { throw "Packaged Pi/compaction probe failed: $LASTEXITCODE" }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
  $env:NODE_OPTIONS = $previousNodeOptions
  $env:NODE_PATH = $previousNodePath
  $env:SYNARA_PROBE_LOCAL_CONTROL = $previousLocalControl
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Continue
}
