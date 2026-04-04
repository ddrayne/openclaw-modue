#!/bin/bash
# Sync source to Modue installed plugins cache
DEST="$HOME/Library/Application Support/modue/installedPlugins/@modue/openclaw/.versions/@modue/openclaw@0.6.0"
rsync -av --exclude=.git --exclude=node_modules --exclude=sync.sh "$(dirname "$0")/" "$DEST/"
echo "Synced. Cmd+Shift+R in Modue to reload."
