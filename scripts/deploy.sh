#!/usr/bin/env bash
set -euo pipefail

# Deploy chrome-devtools-mcp to the target VM
VM="${DEPLOY_HOST:-azureuser@100.108.64.76}"
VERSION="${1:-latest}"

echo "Deploying @vibebrowser/chrome-devtools-mcp@${VERSION} to ${VM}..."
ssh -o StrictHostKeyChecking=no "$VM" \
  "sudo npm install -g @vibebrowser/chrome-devtools-mcp@${VERSION} && \
   systemctl --user restart chrome-devtools-mcp && \
   sleep 3 && \
   curl -s http://localhost:3100/health"
