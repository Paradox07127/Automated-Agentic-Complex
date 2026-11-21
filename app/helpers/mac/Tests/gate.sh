#!/bin/bash
# The helper-mac gate suite: builds ac-helper (.build/release/ac-helper, the path the Electron shell starts), runs the
# package's unit tests and the C12 replay. The last line is the result.
cd "$(dirname "$0")/.." || exit 1
if ! build=$(swift build -c release 2>&1); then
  printf '%s\n' "$build" | tail -20
  echo "HELPER-MAC: FAIL swift build"
  exit 1
fi
unit=$(swift test 2>&1)
unit_rc=$?
executed=$(printf '%s\n' "$unit" | grep -E 'Executed [0-9]+ tests?' | tail -1)
tests=$(printf '%s\n' "$executed" | sed -nE 's/.*Executed ([0-9]+) tests?.*/\1/p')
failures=$(printf '%s\n' "$executed" | sed -nE 's/.*with ([0-9]+) failures?.*/\1/p')
if [ $unit_rc -ne 0 ] || [ "${tests:-0}" -eq 0 ]; then
  printf '%s\n' "$unit" | grep -E 'error:' | head -8
  echo "HELPER-MAC: FAIL swift test ${tests:-0} tests, ${failures:-?} failed"
  exit 1
fi
replay=$(python3 -I Tests/replay.py)
replay_rc=$?
printf '%s\n' "$replay" | sed '$d'
echo "$(printf '%s\n' "$replay" | tail -1); swift test ${tests} tests, ${failures:-0} failed"
exit $replay_rc
