---
name: pbc
description: Control a persistent logged-in Chrome profile with PBC for browser inspection, snapshots, clicks, forms, uploads, downloads, screenshots, and tab management.
---

# PBC

Use `pbc` or `pbc-cli` for browser work that benefits from a persistent Chrome
profile. Prefer its native commands; use `pbc pw` only when the native surface
does not support the required operation.

## Start and inspect

Run `pbc doctor` before diagnosing install or browser health. If CDP is down,
start or recover the browser with `pbc open <url>`. Use the configured default
port unless the user names another one.

```powershell
pbc doctor
pbc open "https://example.com"
pbc tab list --all
pbc tab text active --json
pbc tab snapshot active --json
```

`pbc open` normally reuses the active tab. Add `--new-tab` only when a separate
tab is intended. Numeric tab ids are unstable after tab opens, closes, or
reloads; prefer URL/title matches and refresh the tab list when ids matter.

## Act on pages

Snapshot refs are short values such as `e0` and `e1`:

```powershell
pbc tab snapshot active --json
pbc tab click active e1
pbc tab fill active e2 "value"
pbc tab type active e2 "value" --clear
pbc tab press active Enter
```

Main-frame snapshots and ref clicks use lightweight direct page CDP. This keeps
the live DOM free of PBC attributes and avoids reloads in detach-sensitive apps
such as YouTube Studio. Explicit `--frame` operations retain the Playwright
path. Run a new snapshot after navigation or each multi-step menu transition.

Use `tab upload` rather than the Windows file picker. Multiple paths require a
file input that supports multiple files:

```powershell
pbc tab upload active e3 "C:\absolute\file.png"
pbc tab download active e4
pbc tab screenshot active "C:\absolute\shot.png"
```

For structured reads, prefer `tab text --json`; use `snapshot` when refs or
control metadata are needed. Use `--trace` to collect a reproducible failure.

## Safety and login boundaries

Reuse the saved profile. Use the requested sign-in provider, usually Google,
when login is required. Stop for CAPTCHA, passkeys requiring the user, unknown
2FA, payment confirmation, government ID, or legal signature. Never expose
cookies, passwords, recovery codes, or private account screenshots.

Opening menus and inspecting available accounts is not the same as selecting
an account. Do not change the active account unless the user asked for it.

## Recovery

- Command drift: inspect `pbc --help`; if an update is authorized, run
  `pbc update`, then recheck help and `pbc doctor`.
- CDP down: use `pbc open <url>`.
- Stale refs: take a fresh snapshot and retry once.
- Missing iframe control: run `pbc tab frames active`, then use `--frame`.
- Suspected reload: set a random page value and record
  `performance.timeOrigin`, snapshot, wait, and compare both values.
- Do not automate human-verification controls.

For local PBC development, the usual checkout is
`C:\Users\Naquan\persistent-browser-cli`. After a clear local patch, run
`npm link`, `pbc --help`, and `pbc doctor`, then verify the affected browser
workflow against a disposable tab.
