# TODO

## Now

- [x] Add `doctor`
  - Verify Chrome path, CDP reachability, profile directory, and npm/global shim availability.
- Add `status`
  - Print browser up/down, effective profile path, CDP port, session name, and open tab count.
- Add `tab find`
  - Find tabs by title or URL substring and print stable ids for follow-up commands.
- Add `--json` output mode
  - Make `status`, `tab list`, `tab find`, and `config` script-friendly.
- Add profile ownership checks
  - Refuse to open a second Chrome process on the same user data directory unless an explicit force flag is passed.

## Next

- Add `config`
  - Show effective config values and where each one came from: built-in default, `config.local.json`, or environment variable.
- Add `profile` subcommands
  - `profile list`
  - `profile use <name>`
  - `profile clone <src> <dst>`
  - `profile backup --name <tag>`
  - `profile path`
- Add `tab new`
  - Support explicit new-tab creation instead of only reusing or navigating the current tab.
- Add smarter dedupe options
  - `tab prune --domain`
  - `tab prune --title`
- Add wait/retry flags
  - `--wait-for-cdp`
  - `--timeout`
  - `--retries`

## Later

- Add shell completions for PowerShell
- Add preset shortcuts for common sites
  - `pbc gmail`
  - `pbc github`
  - `pbc indeed`
- Add a `watch cdp` command
  - Poll browser state and emit compact status changes.
- Add structured logging helpers
  - Surface recent CLI and browser-control errors without digging through raw files.
- Add better exit-code coverage
  - Separate config errors, CDP errors, profile lock errors, and Playwright/session errors.

## Not A Priority

- Build a real `.exe`
  - The current npm shim approach already solves the practical command problem on Windows.
  - A packaged executable adds maintenance cost without much workflow benefit right now.
