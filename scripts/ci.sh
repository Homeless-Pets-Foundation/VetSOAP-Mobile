#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-all}"

cd "$ROOT_DIR"

require_node_20() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node 20 is required but node was not found." >&2
    exit 1
  fi

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$node_major" != "20" ]]; then
    echo "Node 20 is required; found $(node --version)." >&2
    exit 1
  fi
}

install_dependencies() {
  npm ci
}

run_r2() {
  (
    cd contracts
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum --check r2-production-destination-v1.sha256
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 --check r2-production-destination-v1.sha256
    else
      echo "An SHA-256 checksum utility (sha256sum or shasum) is required." >&2
      exit 1
    fi
  )
  node --test tests/r2-presigned-upload-contract.test.mjs
  node --test .github/scripts/r2-approval-gate.test.cjs
}

run_typecheck() {
  npm run typecheck
}

run_lint() {
  npm run lint
}

run_tests() {
  npm test
}

run_swift() {
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v xcrun >/dev/null 2>&1; then
    echo "The Swift typecheck requires macOS with Xcode command-line tools." >&2
    exit 1
  fi

  local sdk
  sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
  echo "Using simulator SDK: $sdk"
  xcrun swiftc -typecheck \
    -sdk "$sdk" \
    -target arm64-apple-ios16.0-simulator \
    modules/captivet-durable-recorder/ios/AdtsWriter.swift \
    modules/captivet-durable-recorder/ios/DurablePaths.swift \
    modules/captivet-durable-recorder/ios/DurableManifest.swift \
    modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift \
    ci/durable-expo-stubs.swift
}

run_linux_suite() {
  require_node_20
  install_dependencies
  run_r2
  run_typecheck
  run_lint
  run_tests
}

case "$MODE" in
  r2)
    require_node_20
    run_r2
    ;;
  typecheck)
    require_node_20
    run_typecheck
    ;;
  lint)
    require_node_20
    run_lint
    ;;
  test)
    require_node_20
    run_tests
    ;;
  swift)
    run_swift
    ;;
  linux)
    run_linux_suite
    ;;
  all)
    run_linux_suite
    run_swift
    ;;
  *)
    echo "Usage: $0 {r2|typecheck|lint|test|swift|linux|all}" >&2
    exit 2
    ;;
esac
