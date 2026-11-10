param([string]$VendorRoot=(Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    & node scripts/build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
    & node desktop/stage.mjs $VendorRoot
    if ($LASTEXITCODE -ne 0) { throw 'Staging failed.' }
    $bundledPython=Join-Path $VendorRoot 'resources\runtime\primary-runtime\dependencies\python\python.exe'
    & $bundledPython -I desktop/make-icon.py
    if ($LASTEXITCODE -ne 0) { throw 'Icon build failed.' }
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /optimize+ '/win32manifest:desktop\launcher.manifest' '/win32icon:desktop\chengmeng.ico' '/out:.desktop-build\Launcher.exe' /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Web.Extensions.dll 'desktop\Launcher.cs'
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
    & $bundledPython -I -u desktop/package-exe.py
    if ($LASTEXITCODE -ne 0) { throw 'EXE packaging failed.' }
} finally { Pop-Location }
