#!/usr/bin/env bash
# Pre-build hook: runs expo doctor before any EAS build to catch dependency issues early.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if echo "$COMMAND" | grep -qE 'eas(-cli)?\s+build|eas-cli\s+build'; then
  echo "Running expo doctor before EAS build..." >&2
  npx expo-doctor 2>&1
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "" >&2
    echo "Error: expo doctor found issues. Fix them before building:" >&2
    echo "  npx expo install --fix" >&2
    exit 2
  fi
fi
exit 0
