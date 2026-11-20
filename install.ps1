# Installs PopNow for DaVinci Resolve on Windows. Run from the unzipped folder in PowerShell:
#   .\install.ps1            plugin (Studio) + script   (run as Administrator for the plugin)
#   .\install.ps1 -ScriptOnly
# Quit DaVinci Resolve first.
param([switch]$ScriptOnly)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scripts = Join-Path $env:APPDATA "Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility"
New-Item -ItemType Directory -Force -Path $scripts | Out-Null
Copy-Item (Join-Path $here "script\PopNow.py") (Join-Path $scripts "PopNow.py") -Force
Write-Host "Script installed: Workspace > Scripts > PopNow"
if ($ScriptOnly) { exit 0 }
$support = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support"
$plugins = Join-Path $support "Workflow Integration Plugins"
$target = Join-Path $plugins "ai.popnow.resolve"
$sample = Join-Path $support "Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"
New-Item -ItemType Directory -Force -Path $plugins | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Copy-Item -Recurse (Join-Path $here "ai.popnow.resolve") $target
if (Test-Path $sample) { Copy-Item $sample (Join-Path $target "WorkflowIntegration.node") -Force }
else { Write-Warning "WorkflowIntegration.node was not found under Developer\. The plugin will look for it when it starts." }
Write-Host "Plugin installed: Workspace > Workflow Integrations > PopNow (DaVinci Resolve Studio)"
