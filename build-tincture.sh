#!/usr/bin/env bash
set -euo pipefail
# The readable source is the single source of truth. Historical bundles are
# retained in Git but are no longer used to build the application.
mkdir -p tincture-public
cp -R tincture-site/. tincture-public/
test -f tincture-public/index.html
test -f tincture-public/app.js
test -f tincture-public/styles.css
test -f tincture-public/manifest.webmanifest
test -f tincture-public/sw.js
test -f tincture-public/recipes.mjs
test -f tincture-public/imports.mjs
test -f tincture-public/vendor/xlsx.full.min.js
echo 'Tincture Lab production bundle ready.'
