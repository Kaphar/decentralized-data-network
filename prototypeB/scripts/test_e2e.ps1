# Run the e2e test script (launches 2 nodes and tests API functionality).
# Usage:  .\test_e2e.ps1           # normal speed
#         .\test_e2e.ps1 -Slow     # slow mode with 3s delays for real-time visualization

param(
    [switch]$Slow = $false
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$args = @()
if ($Slow) { $args += "--slow" }

& node (Join-Path $scriptDir "test_e2e.js") @args
