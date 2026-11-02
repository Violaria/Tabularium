#!/usr/bin/env bash
# Builds the original Self-hosted LiveSync and Custom File Explorer sorting plug-ins from the commits recorded in
# upstream/versions.json, for the coexistence scenarios. The output is a local test artefact, like the legacy CLI:
#   .test-runs/upstream-plugins/obsidian-livesync/{main.js,manifest.json,styles.css}
#   .test-runs/upstream-plugins/custom-sort/{main.js,manifest.json,styles.css}
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/.test-runs/upstream-plugins"
work="$root/.test-runs/upstream-plugin-sources"

build() { # name repository commit build-command built-main.js
  local name=$1 repository=$2 commit=$3 command=$4 main=$5
  rm -rf "$work/$name" && mkdir -p "$work/$name" "$out/$name"
  git -C "$root/reference/$repository" archive "$commit" | tar -x -C "$work/$name"
  (cd "$work/$name" && bash -c "$command")
  cp "$work/$name/$main" "$out/$name/main.js"
  for file in manifest.json styles.css; do cp "$work/$name/$file" "$out/$name/$file"; done
  echo "$name: $(node -p "require('$out/$name/manifest.json').version") from $commit"
}

# Self-hosted LiveSync 1.0.40, the commit the Tabularium plug-in started from; its lock file pins Commonlib 0.2.1.
build obsidian-livesync obsidian-livesync 935511c69b111f11b6a52c8daa79b2883f9233dc \
  "npm ci --no-audit --no-fund && npm run build" main.js
# Custom File Explorer sorting 3.2.0 has a yarn.lock only; npm resolves from it when there is no package-lock.json.
build custom-sort obsidian-custom-sort 6100b0c664988b08460c0b7312f77d98770fe3fa \
  "npm install --no-audit --no-fund && node esbuild.config.mjs production" dist/main.js
