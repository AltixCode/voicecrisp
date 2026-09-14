#!/usr/bin/env bash
# Verifies the audio VoiceCrisp exported, read back from the device.
# Usage: .maestro/verify-cleanup.sh <simulator-udid|android>
#
# The cleanup engine is unit tested, but a unit test cannot say that the file on
# disk is what those units produced: the wrong buffer could be encoded, the
# sample rate misread, a stage skipped, or the encoder could undo the work.
set -euo pipefail
TARGET="${1:?usage: verify-cleanup.sh <udid|android>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
BIN="$WORK/verify-cleanup"
swiftc -O "$HERE/verify-cleanup.swift" -o "$BIN"

# The source the app cleaned, regenerated rather than kept as a binary.
( cd "$WORK" && swiftc -O "$HERE/fixtures/make-rough-take.swift" -o gen >/dev/null && ./gen >/dev/null )
SOURCE="$WORK/voicecrisp-rough.wav"

if [ "$TARGET" = android ]; then
  ADB="$HOME/Library/Android/sdk/platform-tools/adb"
  "$ADB" shell content call --uri content://media/ --method scan_volume --arg external_primary >/dev/null 2>&1 || true
  REMOTE="$("$ADB" shell "ls -t /sdcard/Music/*.m4a /sdcard/Movies/*.m4a 2>/dev/null" 2>/dev/null | tr -d '\r' | head -1 || true)"
  [ -n "$REMOTE" ] || { echo "FAIL: no cleaned audio on the device"; exit 1; }
  "$ADB" pull "$REMOTE" "$WORK/cleaned.m4a" >/dev/null
  CLEANED="$WORK/cleaned.m4a"
else
  # The app copies its result into its own Documents folder, which is what the
  # Files app shows. Reading it from there rather than from the temp file the
  # encoder wrote checks the step the user actually depends on.
  CONTAINER="$HOME/Library/Developer/CoreSimulator/Devices/$TARGET/data/Containers/Data/Application"
  CLEANED="$(find "$CONTAINER" -name "*-voicecrisp.m4a" 2>/dev/null | head -1)"
  [ -n "$CLEANED" ] || { echo "FAIL: no cleaned audio in the app's Documents folder"; exit 1; }
fi

"$BIN" "$SOURCE" "$CLEANED"
