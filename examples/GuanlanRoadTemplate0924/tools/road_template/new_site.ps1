# New site end to end: OSM data -> preview project -> native projection -> generate/compile/sync -> captures.
# Re-runnable: an existing preview project is kept, -SkipFetch reuses the downloaded data.
param(
    [Parameter(Mandatory = $true)][string]$Config,
    [string]$Python = $env:ROAD_TEMPLATE_PYTHON,
    [string]$BrowserPython = $env:ROAD_TEMPLATE_BROWSER_PYTHON,
    [switch]$SkipFetch
)
$ErrorActionPreference = 'Stop'
$siteWorkspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $siteWorkspace
try {
    $siteProbe = "import sys; sys.path.insert(0, '.deps/guanlan-gis'); import shapely, numpy"
    $siteCandidates = if ($Python) { @($Python) } else { @(Get-Command python -All | Select-Object -ExpandProperty Source -Unique) }
    $sitePython = $siteCandidates | Where-Object { & $_ -c $siteProbe 2>$null; $LASTEXITCODE -eq 0 } | Select-Object -First 1
    if (-not $sitePython) { throw 'No Python compatible with .deps/guanlan-gis found; pass -Python.' }
    if (-not $BrowserPython) { $BrowserPython = Join-Path $siteWorkspace '../../../../bindings/python/.venv/Scripts/python.exe' }
    $siteConfig = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    $sitePreview = Join-Path ([Environment]::GetFolderPath('UserProfile')) ('.ssworld/projects/' + $siteConfig.name)
    $siteOutput = Join-Path $siteWorkspace $siteConfig.output_dir

    if (-not $SkipFetch) { & $sitePython tools/road_template/fetch_osm.py --config $Config; if ($LASTEXITCODE) { throw 'OSM download failed' } }
    if (-not (Test-Path -LiteralPath (Join-Path $sitePreview 'showcase.manifest.json'))) {
        node tools/road_template/create_preview.mjs $Config; if ($LASTEXITCODE) { throw 'Preview project creation failed' }
    }
    $siteCache = Join-Path $siteOutput 'projection-cache.json'
    # Exit code only: under 'Stop', PowerShell 5 turns native stderr into a terminating error.
    & $sitePython -c "import sys,json; sys.path[:0]=['tools','.deps/guanlan-gis']; from road_template.projection import load`ntry: load(json.load(open(sys.argv[1],encoding='utf-8')))`nexcept Exception: sys.exit(3)" $Config
    if ($LASTEXITCODE) {
        # No valid native projection yet: publish the bootstrap page and press its conversion button.
        node tools/road_template/compile.mjs $Config; if ($LASTEXITCODE) { throw 'Bootstrap compile failed' }
        Copy-Item -Path (Join-Path $siteOutput '*') -Destination $sitePreview -Recurse -Force
        $siteBridge = Start-Process -FilePath $sitePython -ArgumentList @('tools/generate_roads.py', '--config', $Config, '--serve-projection') -PassThru -WindowStyle Hidden
        try {
            Start-Sleep -Seconds 2
            if (Test-Path -LiteralPath $BrowserPython) {
                & $BrowserPython tools/road_template/browser.py project --config $Config; if ($LASTEXITCODE) { throw 'Native projection failed' }
            } else {
                Write-Output "Open http://127.0.0.1:8880/projects/$($siteConfig.name)/index.html, press 数据、规则与生成说明 -> 使用 SSEngine 重新转换坐标, then press Enter."
                Read-Host | Out-Null
            }
        } finally { Stop-Process -Id $siteBridge.Id -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path -LiteralPath $siteCache)) { throw 'projection-cache.json was not written' }
    }
    & (Join-Path $PSScriptRoot 'rebuild.ps1') -Config $Config -Python $sitePython -SyncPreview
    if (Test-Path -LiteralPath $BrowserPython) { & $BrowserPython tools/road_template/browser.py shots --config $Config }
    Write-Output "Preview: http://127.0.0.1:8880/projects/$($siteConfig.name)/index.html"
} finally { Pop-Location }
