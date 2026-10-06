#!/usr/bin/env bash
set -euo pipefail
rm -rf site site.tar.gz site.b64
cat deploy-bundle/part000 deploy-bundle/part001 deploy-bundle/part002 deploy-bundle/part003 deploy-bundle/part004 > site.b64
base64 -d site.b64 > site.tar.gz
tar -xzf site.tar.gz
test -f site/index.html
test -f site/app.js
test -f site/styles.css
test -f site/manifest.webmanifest
test -f site/sw.js
echo 'Tincture Lab production bundle ready.'
