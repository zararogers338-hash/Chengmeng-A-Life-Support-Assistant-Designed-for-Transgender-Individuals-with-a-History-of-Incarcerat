# Install the finished module into this project's isolated development profile.
# Does not restart DSH, modify ~/.dsh, select a model, or send a prompt.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$moduleRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$devHome = Join-Path $projectRoot '.dsh-dev'
$profilePath = Join-Path $devHome 'profiles\chengmeng-dev'
$dshCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path -LiteralPath $dshCli)) { throw 'DeepSeek Harness CLI not found.' }
if (-not (Test-Path -LiteralPath $profilePath)) { throw 'Existing chengmeng-dev profile not found; no profile was created or replaced.' }

$previousHome = $env:DSH_HOME
try {
    $env:DSH_HOME = $devHome
    & node (Join-Path $PSScriptRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Agent core build failed.' }
    & $dshCli plugin --profile chengmeng-dev add $moduleRoot
    if ($LASTEXITCODE -ne 0) { throw 'Agent core installation failed.' }
    Write-Output 'Installed in .dsh-dev only. Restart the development instance when convenient, then select Chengmeng for a new conversation.'
} finally {
    $env:DSH_HOME = $previousHome
}
