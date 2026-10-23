#!/bin/bash
# Run the e2e test script (launches 2 nodes and tests API functionality).
# Usage:  ./test_e2e.sh           # normal speed
#         ./test_e2e.sh --slow    # slow mode with 3s delays for real-time visualization

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$script_dir/test_e2e.js" "$@"
