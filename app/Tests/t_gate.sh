#!/bin/bash
# The four gate wrappers of tools/qa/gate.py, each in a tree of stub suites: a wrapper must exit non-zero when any one suite
# fails and print a `receipt:` line naming a receipt whose result matches its exit code.
set -uo pipefail
tests="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$tests/../.." && pwd)"
mkdir -p "${TMPDIR:-/tmp}/companion-tests"
# Two steps: cd "" succeeds in place, so a failed mktemp inside $(cd ...) would make the trap remove the current directory.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/companion-tests/tgate.XXXXXX")" || exit 1
tmp="$(cd "$scratch" && pwd -P)" || exit 1
trap 'rm -rf "$tmp"' EXIT
export AGENTD_PYTHON="$(command -v python3)"
scripts="app/Tests/gate.sh tools/qa/mac_gate.sh tools/qa/web_gate.sh tools/qa/agentd_gate.sh"
runner="tools/qa/gate.py tools/qa/gate_daemon.py tools/qa/suites.json tools/release/gate_receipt.py
    tools/release/source_fingerprint.py tools/release/release.py tools/platform/agentd-python.sh"
extra=$("$AGENTD_PYTHON" -I -B -c 'import sys; sys.path.insert(0, sys.argv[1]); import source_fingerprint as s; print(*s.EXTRA_FILES)' \
    "$src/tools/release")

# Writes an executable stub at $1 that prints $2 and exits $3.
stub() { mkdir -p "$(dirname "$1")"; printf '#!/bin/bash\necho "%s"\nexit %s\n' "$2" "$3" > "$1"; chmod +x "$1"; }
# The start of every swift stub: `--xunit-output <file>` writes a passing 103-test xUnit summary there.
XUNIT='#!/bin/bash
p=; for a in "$@"; do [ "$p" = --xunit-output ] && echo "<testsuites><testsuite name=\"TestResults\" errors=\"0\" tests=\"103\" failures=\"0\"/></testsuites>" > "$a"; p=$a; done'
# A swift stub prints an xctest bundle summary, as `swift test` does, then $2.
swift_stub() { mkdir -p "$(dirname "$1")"; { echo "$XUNIT"; printf 'echo "Test Suite '"'"'X.xctest'"'"' passed"\necho "%s"\nexit %s\n' "$2" "$3"; } > "$1"; chmod +x "$1"; }
pystub() { mkdir -p "$(dirname "$1")"; printf 'import sys\nprint("%s")\nsys.exit(%s)\n' "$2" "$3" > "$1"; }
unit_module() { mkdir -p "$(dirname "$1")"; printf 'import unittest\n\n\nclass T(unittest.TestCase):\n' > "$1"
    for n in $(seq "$2"); do printf '    def test_%s(self):\n        self.assertTrue(%s)\n' "$n" "$3" >> "$1"; done; }
# web_stub <tree> <step that fails: none, node, ci, check, unit or e2e>: the node, npm and npx that web_gate.sh calls.
web_stub() {
    local r=$1 fail=$2 major=24
    [ "$fail" = node ] && major=22
    mkdir -p "$r/bin" "$r/web"
    printf '#!/bin/bash\ncase "$1" in -p) echo %s ;; *) echo v%s.1.0 ;; esac\n' $major $major > "$r/bin/node"
    printf '#!/bin/bash\nstep=$1; [ "$1" = run ] && step=$2\n[ "$step" = e2e ] && echo "  3 passed (1.2s)"\n[ "$step" = %s ] && exit 1\nexit 0\n' \
        "$fail" > "$r/bin/npm"
    printf '#!/bin/bash\nif [ "$1" = vitest ]; then\n  [ %s = unit ] && { echo "      Tests  1 failed | 4 passed (5)"; exit 1; }\n  echo "      Tests  5 passed (5)"; exit 0\nfi\nwhile [ "$1" != --outDir ]; do shift; done\nmkdir -p "$2" && touch "$2/main.html" "$2/stack.html"\n' \
        "$fail" > "$r/bin/npx"
    chmod +x "$r/bin/node" "$r/bin/npm" "$r/bin/npx"
}

# Builds a passing git checkout in $1; the case then breaks one suite.
tree() {
    local r=$1 f
    for f in $extra; do mkdir -p "$(dirname "$r/$f")"; echo true > "$r/$f"; done
    for f in $scripts $runner; do mkdir -p "$(dirname "$r/$f")"; cp "$src/$f" "$r/$f"; done
    for s in build_app.sh package_release.sh; do echo true > "$r/app/$s"; done
    swift_stub "$r/bin/swift" "Executed 103 tests, with 0 failures (0 unexpected)" 0
    printf '#!/bin/bash\nshift\nexec "$@"\n' > "$r/tools/platform/gpu-lock.sh"
    chmod +x "$r/tools/platform/gpu-lock.sh"
    pystub "$r/protocol/C3-host-ipc/validate.py" "C3 examples ok" 0
    # The local suites (host-link, render-*, the local renderer tests) join the gate when private/suites.json exists.
    mkdir -p "$r/private/renderer-tests"; [ -f "$src/private/suites.json" ] && cp "$src/private/suites.json" "$r/private/"
    stub "$r/private/renderer-tests/scripts/host_link/run_host_link.sh" "host link: 3 passed, 0 failed" 0
    stub "$r/private/renderer-tests/scripts/host_link/run_host_link_electron.sh" "host link electron: 3 passed, 0 failed" 0
    stub "$r/private/renderer-tests/scripts/render_gate.sh" "render ok" 0
    stub "$r/private/renderer/core/build.sh" "player core built" 0
    stub "$r/private/renderer/common/build.sh" "host common built" 0
    stub "$r/private/renderer/core/build/core_tests" "PLAYER-CORE: 3 checks, 0 failed" 0
    stub "$r/private/renderer/common/build/common_tests" "HOST-COMMON: 3 checks, 0 failed" 0
    stub "$r/app/Tests/t5_watch.sh" "t5_watch PASS" 0
    web_stub "$r" none
    unit_module "$r/agent/agentd/tests/test_a.py" 2 True
    unit_module "$r/agent/agentd/tests/test_b.py" 1 True
    printf '/.local/\n__pycache__/\n' > "$r/.gitignore"
    git -C "$r" init -q -b main && git -C "$r" add -A \
        && git -C "$r" -c user.name=t -c user.email=t@t commit -q -m stub
}

# run <tree> <output stem> <script> [args...]: @r in args stands for the tree, @logs for a log dir.
run() {
    local r=$1 out=$2 script=$3 a; shift 3
    local args=()
    for a in "$@"; do case $a in @r) args+=("$r") ;; @logs) args+=("$out.logs") ;; *) args+=("$a") ;; esac; done
    PATH="$r/bin:$PATH" bash "$r/$script" ${args[@]+"${args[@]}"} > "$out.out" 2> "$out.err"
}

bad=0
# check <case> <pass|fail> <script> [args...]: the wrapper in tree $tmp/<case>.
check() {
    local name=$1 want=$2 script=$3 r=$tmp/$1; shift 3
    run "$r" "$r" "$script" "$@"
    local code=$?
    local ok=1 receipt result verdict=PASS
    if ! { { [ "$want" = pass ] && [ $code -eq 0 ]; } || { [ "$want" = fail ] && [ $code -ne 0 ]; }; }; then
        echo "  $name exit=$code, want $want"; ok=0
    fi
    [ $code = 0 ] || verdict=FAIL
    receipt=$(sed -n 's/^receipt: //p' "$r.out")
    result=$("$AGENTD_PYTHON" -I -B -c 'import json, sys; print(json.load(open(sys.argv[1]))["result"])' "$receipt" 2>/dev/null)
    [ "$result" = $verdict ] || { echo "  $name receipt '$receipt' has result '$result', want $verdict"; ok=0; }
    if [ $ok = 1 ]; then echo "  $name exit=$code ok"; else sed 's/^/    /' "$r.out" "$r.err"; bad=1; fi
}
host=app/Tests/gate.sh mac=tools/qa/mac_gate.sh web=tools/qa/web_gate.sh agentd=tools/qa/agentd_gate.sh
one_test() {  # A --filter run that selects one test prints "1 test", singular.
    { echo "$XUNIT"; printf 'echo "Test Suite '"'"'X.xctest'"'"' passed"\ncase "$*" in *--filter*) echo "Executed 1 test, with 0 failures (0 unexpected)" ;; *) echo "Executed 103 tests, with 0 failures (0 unexpected)" ;; esac\n'; } > "$1/bin/swift"
}
build_fails() {  # `swift build` (renderer-build) fails; `swift test` passes.
    { echo '#!/bin/bash'; echo '[ "$1" = build ] && { echo "error: build broke"; exit 1; }'; tail -n +2 "$1/bin/swift"; } > "$1/bin/swift.new"
    mv "$1/bin/swift.new" "$1/bin/swift"; chmod +x "$1/bin/swift"
}

tree "$tmp/all_pass"; check all_pass pass $host
tree "$tmp/script_syntax"; echo 'if' > "$tmp/script_syntax/app/package_release.sh"; check script_syntax fail $host
tree "$tmp/one_test"; one_test "$tmp/one_test"; check one_test pass $host
if [ -f "$src/private/suites.json" ]; then
    tree "$tmp/swift_fails"; stub "$tmp/swift_fails/bin/swift" "error: build failed" 1; check swift_fails fail $host
    tree "$tmp/swift_count"; swift_stub "$tmp/swift_count/bin/swift" "Executed 103 tests, with 1 failure (0 unexpected)" 0; check swift_count fail $host
    tree "$tmp/swift_red"; swift_stub "$tmp/swift_red/bin/swift" "Executed 103 tests, with 1 failure (0 unexpected)" 1; check swift_red fail $host
    tree "$tmp/no_tests"; swift_stub "$tmp/no_tests/bin/swift" "Executed 0 tests, with 0 failures (0 unexpected)" 0; check no_tests fail $host
    tree "$tmp/build_fails"; build_fails "$tmp/build_fails"; check build_fails fail $host
    tree "$tmp/host_link_fails"; stub "$tmp/host_link_fails/private/renderer-tests/scripts/host_link/run_host_link.sh" "host link: 2 passed, 1 failed" 1; check host_link_fails fail $host
fi
tree "$tmp/first_of_loop"; stub "$tmp/first_of_loop/app/Tests/t5_watch.sh" "T5-WATCH FAIL" 1; check first_of_loop fail $host
tree "$tmp/web_fails"; web_stub "$tmp/web_fails" check; check web_fails fail $host
tree "$tmp/web_node_fails"; web_stub "$tmp/web_node_fails" node; check web_node_fails fail $host

tree "$tmp/mac_pass"; check mac_pass pass $mac @r @logs
tree "$tmp/mac_perf"; check mac_perf pass $mac @r @logs --perf
tree "$tmp/mac_one_test"; one_test "$tmp/mac_one_test"; check mac_one_test pass $mac @r @logs --perf
if [ -f "$src/private/suites.json" ]; then
    tree "$tmp/mac_swift_count"; swift_stub "$tmp/mac_swift_count/bin/swift" "Executed 103 tests, with 1 failure (0 unexpected)" 0; check mac_swift_count fail $mac @r @logs
    tree "$tmp/mac_swift_red"; swift_stub "$tmp/mac_swift_red/bin/swift" "Executed 103 tests, with 1 failure (0 unexpected)" 1; check mac_swift_red fail $mac @r @logs
    tree "$tmp/mac_no_tests"; swift_stub "$tmp/mac_no_tests/bin/swift" "Executed 0 tests, with 0 failures (0 unexpected)" 0; check mac_no_tests fail $mac @r @logs
    tree "$tmp/mac_build_fails"; build_fails "$tmp/mac_build_fails"; check mac_build_fails fail $mac @r @logs
    tree "$tmp/mac_host_link_fails"; stub "$tmp/mac_host_link_fails/private/renderer-tests/scripts/host_link/run_host_link.sh" "host link: 2 passed, 1 failed" 1; check mac_host_link_fails fail $mac @r @logs
fi

tree "$tmp/web_pass"; check web_pass pass $web @r @logs
for step in node ci check unit e2e; do tree "$tmp/web_$step"; web_stub "$tmp/web_$step" $step; check web_$step fail $web @r @logs; done

tree "$tmp/agentd_pass"; check agentd_pass pass $agentd @r @logs 2
tree "$tmp/agentd_fails"; unit_module "$tmp/agentd_fails/agent/agentd/tests/test_b.py" 1 False; check agentd_fails fail $agentd @r @logs 2

[ $bad = 0 ] && echo "T-GATE PASS" || { echo "T-GATE FAIL"; exit 1; }
