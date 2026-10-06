#!/usr/bin/env bash
set -euo pipefail
rm -rf tincture-public site.tar.gz site.b64
mkdir -p tincture-public
cat deploy-bundle/part000 deploy-bundle/part001 deploy-bundle/part002 deploy-bundle/part003 deploy-bundle/part004 > site.b64
base64 -d site.b64 > site.tar.gz
tar -xzf site.tar.gz --strip-components=1 -C tincture-public
test -f tincture-public/index.html
test -f tincture-public/app.js
test -f tincture-public/styles.css
test -f tincture-public/manifest.webmanifest
test -f tincture-public/sw.js
echo 'Tincture Lab production bundle ready.'
