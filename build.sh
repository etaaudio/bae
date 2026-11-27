#!/bin/sh
# Builds dist/bae-chrome.zip and dist/bae-firefox.zip, and dist/bae-safari.zip on a Mac with Xcode.
# Each browser gets only the manifest keys it uses, so none of them warns about the others'.
set -eu
cd "$(dirname "$0")"
FILES="background.js bridge.js page.js popup.html popup.js icons LICENSE PRIVACY.md README.md"
rm -rf dist && mkdir dist

pack() { # pack <browser> <jq filter applied to manifest.json>
  mkdir "dist/$1"
  cp -R $FILES "dist/$1/"
  jq "$2" manifest.json > "dist/$1/manifest.json"
  (cd "dist/$1" && zip -qrX "../bae-$1.zip" .)
}
pack chrome  'del(.background.scripts, .browser_specific_settings)'
pack firefox 'del(.background.service_worker, .minimum_chrome_version)'

# ponytail: unsigned build; sign it here once the Apple developer account is ready
if xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  pack safari '.'
  xcrun safari-web-extension-converter dist/safari --project-location dist/xcode \
    --app-name BAE --bundle-identifier com.etaaudio.BAE --macos-only --no-open --no-prompt --force
  xcodebuild -quiet -project dist/xcode/BAE/BAE.xcodeproj -scheme BAE -configuration Release \
    -derivedDataPath dist/derived CODE_SIGNING_ALLOWED=NO build
  rm dist/bae-safari.zip
  ditto -c -k --keepParent dist/derived/Build/Products/Release/BAE.app dist/bae-safari.zip
fi
ls -l dist/*.zip
