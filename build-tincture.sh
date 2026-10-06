#!/usr/bin/env bash
set -euo pipefail

rm -rf tincture-public
mkdir -p tincture-public

cat   tincture-build/part00.b64   tincture-build/part01.b64   tincture-build/part02.b64   tincture-build/part03.b64   tincture-build/part04.b64   | base64 -d > /tmp/tincture-deploy.tar.gz

tar -xzf /tmp/tincture-deploy.tar.gz -C tincture-public

test -f tincture-public/index.html
test -f tincture-public/app.js
test -f tincture-public/styles.css
test -f tincture-public/manifest.webmanifest
test -f tincture-public/sw.js

echo "Tincture Lab production bundle ready."
