#!/usr/bin/env bash
# Generate a test Ed25519 keypair for local development.
# Requires: Rust (cargo) with the project built, or openssl.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <output_file.json>"
    exit 1
fi

OUTPUT="$1"

# Generate a random 32-byte secret key
SECRET=$(openssl rand -hex 32)

# Use the Rust node's crypto module to derive the public key and create a key file
# For Phase 0, this script generates a raw keypair JSON for reference.
# Full key encryption (Phase 2) will use Argon2 + AES-GCM.

echo "{\"secret\":\"${SECRET}\",\"format\":\"raw_ed25519\",\"note\":\"dev-only, do not use in production\"}" > "$OUTPUT"

echo "Generated test keypair at: $OUTPUT"
echo "Secret (hex): $SECRET"
echo ""
echo "To use with the node:"
echo "  1. Set DDN_SECRET=$SECRET environment variable when starting the node"
echo "  2. Or import this file via the key management API (Phase 1+)"
