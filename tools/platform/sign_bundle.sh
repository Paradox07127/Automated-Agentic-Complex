#!/bin/bash
# Usage: tools/platform/sign_bundle.sh </abs/Some.app> | --payload <dir>
# Signs every Mach-O and nested bundle inside-out, then the app; app mode leaves C11 components alone.
# A Developer ID identity adds hardened runtime, a secure timestamp and per-executable entitlements;
# any other identity signs without them. No --deep, no notarization.
# Identity: AAC_SIGN_IDENTITY, else the first line of .local/signing-identity in the main checkout, else ad hoc ("-").
set -euo pipefail
app=
components=
if [ "$1" = --payload ]; then
    root=${2%/}
else
    app=${1%/}
    root="$app/Contents"
    components="$root/Resources/components"
    [ -d "$root" ] || { echo "not an app bundle: $app" >&2; exit 2; }
fi
common=$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
identity=${AAC_SIGN_IDENTITY:-$(head -1 "$common/../.local/signing-identity" 2>/dev/null || true)}
identity=${identity:--}

# Developer ID only: glob on the path below the app's Contents (or the payload; "." is the app itself)
# = app/packaging/entitlements/<name>.plist. First match wins; libraries, frameworks and other bundles get none.
entitlements=(
    '.=main'
    'Frameworks/* Helper (GPU).app=helper-gpu'
    'Frameworks/* Helper (Renderer).app=helper-renderer'
    'Frameworks/* Helper (Plugin).app=helper-plugin'
    'Frameworks/* Helper.app=helper'
    'MacOS/ac-helper=ac-helper'
    'MacOS/AgenticComplexMetalAvatar=renderer'
    'node/bin/node=node'
    'bin/python3.[0-9]*=python'
)
developer_id=
case $identity in 'Developer ID Application:'*)
    developer_id=1
    entitlements_dir="$(cd "$(dirname "$0")/../.." && pwd)/app/packaging/entitlements";;
esac

sign() {
    local options=(--timestamp=none) relative rule
    if [ -n "$developer_id" ]; then
        options=(--options runtime --timestamp)
        relative=${1#"$root"/}
        [ "$1" != "$app" ] || relative=.
        for rule in "${entitlements[@]}"; do
            case $relative in ${rule%=*}) options+=(--entitlements "$entitlements_dir/${rule##*=}.plist"); break;; esac
        done
    fi
    codesign --force "${options[@]}" --sign "$identity" "$1"
}

main_exe() { /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist" 2>/dev/null || true; }
depth() { awk -F/ '{print NF "\t" $0}'; }

# A bundle's own main executable is sealed when the bundle itself is signed.
skip=()
[ -n "$app" ] && skip+=("$app/Contents/MacOS/$(main_exe "$app")")
targets=()
while IFS= read -r -d '' dir; do
    targets+=("$dir")
    exe=$(main_exe "$dir"); [ -n "$exe" ] && skip+=("$dir/Contents/MacOS/$exe")
done < <(find "$root" -path "$components" -prune -o -type d \( -name '*.app' -o -name '*.bundle' -o -name '*.framework' -o -name '*.plugin' -o -name '*.appex' -o -name '*.xpc' \) -print0)
while IFS= read -r -d '' f; do
    case "$(file -b "$f")" in *Mach-O*) targets+=("$f");; esac
done < <(find "$root" -path "$components" -prune -o -type f -print0)

count=0
while IFS=$'\t' read -r _ path; do
    [ -n "$path" ] || continue
    for s in "${skip[@]-}"; do [ "$path" = "$s" ] && continue 2; done
    sign "$path"
    count=$((count + 1))
done < <(printf '%s\n' "${targets[@]-}" | depth | sort -t$'\t' -k1,1nr)

if [ -z "$app" ]; then
    echo "signed $count items in $root"
    exit 0
fi

sign "$app"
codesign --verify --strict --deep "$app"
echo "signed $count nested items and $app"
codesign -d -r- "$app" 2>&1 | grep 'designated =>'
