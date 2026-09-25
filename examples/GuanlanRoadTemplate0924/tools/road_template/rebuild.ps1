param(
    [string]$Config = 'tools/road_template/configs/guanlan.json',
    [string]$Python = $env:ROAD_TEMPLATE_PYTHON,
    [switch]$SyncPreview
)
$ErrorActionPreference = 'Stop'
$roadWorkspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $roadWorkspace
try {
    $roadProbe = @'
import sys
sys.path.insert(0, '.deps/guanlan-gis')
try:
 import shapely, numpy
except Exception:
 sys.exit(1)
'@
    $roadCandidates = if ($Python) { @($Python) } else { @(Get-Command python -All | Select-Object -ExpandProperty Source -Unique) }
    $roadPython = $null
    foreach ($candidate in $roadCandidates) {
        & $candidate -c $roadProbe
        if ($LASTEXITCODE -eq 0) { $roadPython = $candidate; break }
    }
    if (-not $roadPython) { throw 'No Python compatible with .deps/guanlan-gis found. Install Shapely/NumPy for your interpreter or pass -Python.' }
    Write-Output "Using Python: $roadPython"
    & $roadPython tools/generate_roads.py --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Road geometry generation failed' }
    node tools/road_template/compile.mjs $Config
    if ($LASTEXITCODE -ne 0) { throw 'SSWorld compilation failed' }
    if ($SyncPreview) {
        $roadConfig = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($roadConfig.name -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,63}$') { throw 'Invalid SSWorld project name' }
        $roadOutput = [IO.Path]::GetFullPath((Join-Path $roadWorkspace $roadConfig.output_dir))
        if (-not $roadOutput.StartsWith($roadWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay inside the workspace' }
        $roadPreview = Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.ssworld/projects/' + $roadConfig.name)
        if (-not (Test-Path -LiteralPath (Join-Path $roadPreview 'showcase.manifest.json'))) { throw 'Create the named SSWorld project before syncing' }
        Copy-Item -Path (Join-Path $roadOutput '*') -Destination $roadPreview -Recurse -Force
        Write-Output "Preview project updated: $roadPreview"
    }
} finally { Pop-Location }
