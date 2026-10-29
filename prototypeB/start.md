# Quick Start - Multiple Local Nodes (PowerShell)

# Terminal 1
$env:DDN_DATA_DIR = ".\data1"; $env:DDN_HTTP_PORT = "3001"; $env:DDN_P2P_PORT = "4001"
cargo run

# Terminal 2
$env:DDN_DATA_DIR = ".\data2"; $env:DDN_HTTP_PORT = "3002"; $env:DDN_P2P_PORT = "4002"
cargo run

# After first run, each node has its own identity locked behind a password.
# To unlock, call from any browser or curl:
#   POST http://localhost:3001/api/identity/unlock  { "password": "..." }

# Access the apps in a browser:
#   Node 1: http://localhost:3001      (wall, chat, communities, files, ...)
#   Node 2: http://localhost:3002      (separate identity + data)
#
# dApps (served by the node, open in any browser):
#   http://localhost:3001/dapp/guestbook
#   http://localhost:3001/dapp/chaindemo
#   http://localhost:3001/dapp/notes
#
# In the main app, use the "Node URL" input in the header to point
# any browser at a different node (e.g. http://localhost:3002).
