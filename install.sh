#!/bin/bash
# Installs PopNow for DaVinci Resolve on macOS. Run it from the unzipped folder:
#   ./install.sh            plugin (Studio) + script
#   ./install.sh --script   script only (no admin password needed)
# Quit DaVinci Resolve first. The plugin folder is shared by all users, so it asks for your password.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
support="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
plugins="$support/Workflow Integration Plugins"
sample="$support/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
scripts="$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility"

mkdir -p "$scripts"
cp "$here/script/PopNow.py" "$scripts/PopNow.py"
echo "Script installed: Workspace > Scripts > PopNow"

if [ "${1:-}" = "--script" ]; then exit 0; fi
if [ ! -d "$support" ]; then
  echo "DaVinci Resolve is not installed in /Applications; only the script was installed." >&2
  exit 0
fi
sudo mkdir -p "$plugins"
sudo rm -rf "$plugins/ai.popnow.resolve"
sudo cp -R "$here/ai.popnow.resolve" "$plugins/ai.popnow.resolve"
# WorkflowIntegration.node ships with Resolve; the plugin uses the copy from your own install.
if [ -f "$sample" ]; then
  sudo cp "$sample" "$plugins/ai.popnow.resolve/WorkflowIntegration.node"
else
  echo "Note: WorkflowIntegration.node was not found under Developer/. The plugin will look for it when it starts." >&2
fi
echo "Plugin installed: Workspace > Workflow Integrations > PopNow (DaVinci Resolve Studio)"
