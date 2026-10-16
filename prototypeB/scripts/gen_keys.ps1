# Generate a test Ed25519 keypair for local development.
# Cross-platform replacement for gen_keys.sh - works without openssl.
# Requires: Node.js

param(
    [Parameter(Mandatory=$true)]
    [string]$Output
)

$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

$json = @{
    secret = $secret
    format = "raw_ed25519"
    note   = "dev-only, do not use in production"
} | ConvertTo-Json -Compress

Set-Content -Path $Output -Value $json

Write-Host "Generated test keypair at: $Output"
Write-Host "Secret (hex): $secret"
Write-Host ""
Write-Host "To use with the node:"
Write-Host "  1. Set DDN_SECRET=$secret environment variable when starting the node"
Write-Host "  2. Or import this file via the key management API (Phase 1+)"
