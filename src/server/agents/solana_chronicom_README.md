# Solana Chronicom Watcher (T2000 Protocol)

This daemon fulfills **Bounty #21 (Quest: Register kamino.sui by paying with Solana)** for the `.SKI` ecosystem. It acts as an autonomous Chronicom watcher that polls the Solana RPC network for cross-chain SUIAMI registrations.

## Features
- **Zero Dependencies**: Uses Python's built-in `requests` library (minimal bloat).
- **Intelligent RPC Polling**: Uses `getSignaturesForAddress` with `until` pagination to efficiently fetch only new transactions.
- **Deep Transaction Parsing**: Inspects `jsonParsed` instructions to find both:
  1. `SystemProgram` transfer to Ultron's IKA ed25519 address.
  2. `SPL Memo` containing a target `.sui` domain name (e.g. `kamino.sui`).
- **Autonomous Sibyl/Treasury Integration**: Triggers the `/api/treasury/mint-iusd` endpoint exactly as `TreasuryAgents` expects.

## Usage

1. Ensure Python 3.9+ is installed.
2. Edit `solana_chronicom.py` to add `ULTRON_SOLANA_ADDRESS_PLACEHOLDER` (derived after DKG provisioning).
3. Run as daemon:
```bash
python3 solana_chronicom.py
```

## Systemd Service (Optional)
To run permanently as an autonomous Triarchy agent worker:
```ini
[Unit]
Description=Solana Chronicom Watcher
After=network.target

[Service]
ExecStart=/usr/bin/python3 /path/to/solana_chronicom.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```
