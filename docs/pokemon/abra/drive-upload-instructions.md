# Drive Upload Manifest — Superteam Grant

The Superteam grant evaluator asked for response files in a Drive link.
Put the following in one shared folder and send the link with the
application.

## Folder structure

```
superteam-agentic-grant-ski/
├── 00-application.md                 # rendered from application-draft.md
├── 01-session-evidence.md            # rendered from session-evidence.md
├── 02-commit-log.txt                 # `git log --oneline 4ee5f75..c788108`
├── 03-rumble-ultron-screencast.mp4   # browser DKG ceremony, ~90s
├── 04-sweep-tx-links.md              # mainnet tx hashes for the $227.22 sweep
├── 05-wasm-in-do-spike.md            # Toxic Spikes write-up + DO logs
└── 06-parallel-subagents.png         # screenshot of 4 concurrent lanes
```

## File-by-file source

| Drive file                          | Source in repo                                      |
|-------------------------------------|-----------------------------------------------------|
| `00-application.md`                 | `docs/pokemon/abra/application-draft.md`            |
| `01-session-evidence.md`            | `docs/pokemon/abra/session-evidence.md`             |
| `02-commit-log.txt`                 | `git log --oneline 4ee5f75..c788108 > commit-log.txt` |
| `03-rumble-ultron-screencast.mp4`   | Record: open SKI, hit `window.rumbleUltron()`, let it run, stop |
| `04-sweep-tx-links.md`              | Grab from Helius explorer for `ULTRON_SOL_ADDRESS` both old and new |
| `05-wasm-in-do-spike.md`            | Write-up of commit `b449dd3` + DO logs from wrangler tail |
| `06-parallel-subagents.png`         | Screenshot of the Claude Code session with 4 lanes |

## Process

1. Generate the commit log:
   ```bash
   git log --oneline 4ee5f75..c788108 > /tmp/commit-log.txt
   ```
2. Export the two markdown files as-is (no conversion needed — Drive
   renders `.md` fine).
3. Record the Rumble screencast from a clean browser session so the
   DKG console output is visible.
4. Pull sweep tx hashes from Helius — both sides of commit `5898697`.
5. Write the spike narrative from `b449dd3`'s code + live DO logs.
6. Take the parallel-subagents screenshot from the Claude Code tab at
   the moment all four lanes are showing activity.
7. Upload everything to `superteam-agentic-grant-ski/` in Drive.
8. Share the folder link with Superteam reviewers (view-only).
9. Paste the link into the grant application form.

## Notes for the evaluator

- Everything in the folder is reproducible from the `.SKI` repo at
  commit `c788108` on `devnet/nursery`.
- Mainnet is live — no staging environment. Any claim in the application
  can be verified by calling the endpoint directly or by reading the
  on-chain state.
- The Pokemon commit names are not decoration; they are a first-class
  versioning convention documented in
  `feedback_pokemon_versioning.md`.
