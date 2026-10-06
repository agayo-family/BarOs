#!/usr/bin/env bash
set -euo pipefail
rm -rf tincture-public
mkdir -p tincture-public
cat tincture-runtime.part*.b64 | base64 -d > /tmp/tincture-runtime.tar.gz
tar -xzf /tmp/tincture-runtime.tar.gz -C tincture-public
