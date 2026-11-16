---
name: pbc
description: Control a persistent logged-in Chrome profile with PBC for browser inspection, snapshots, clicks, forms, uploads, downloads, screenshots, and tab management.
---

# PBC

Use `pbc` or `pbc-cli` for browser work that benefits from a persistent Chrome
profile. Prefer its native commands; use `pbc pw` only when the native surface
does not support the required operation.

## Exclusive use and navigation

Only one agent may use PBC at a time, including workers in a Switchyard swarm
sharing a coordination directory. Before using PBC, check shared coordination
state and claim the browser through the swarm's existing mechanism. If another
worker owns it, wait for explicit release; release your claim when finished. A
tab list alone does not establish that the browser is unclaimed. If `pbc doctor`
reports CDP down, assume no agent is currently using PBC, but coordinate a claim
before starting it to prevent a race. Do not interrupt an active user or worker.

Prefer navigation using fresh snapshots and visible links, buttons, and search
controls. Avoid `pbc tab goto` and equivalent direct navigation when a normal UI
route is available; it can trigger anti-bot checks. Direct navigation is suitable
when necessary, such as opening the initial site or when UI navigation is unavailable.

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
pbc tab rclick active e1
pbc tab drag active e1 to e2
pbc tab fill active e2 "value"
pbc tab type active e2 "value" --clear
pbc tab press active Enter
```

Main-frame snapshots, text extraction, screenshots, ref clicks, and file
uploads use lightweight direct page CDP. This keeps the live DOM free of PBC
attributes and avoids reloads in detach-sensitive apps such as YouTube Studio.
Explicit `--frame` operations retain the Playwright path. Run a new snapshot
after navigation or each multi-step menu transition.

Use `tab upload` rather than the Windows file picker. The snapshot ref may be a
file input or the visible Import/Upload button that opens the chooser; PBC
intercepts the chooser and assigns the file directly. Multiple paths require a
chooser that supports multiple files:

```powershell
pbc tab upload active e3 "C:\absolute\file.png"
pbc tab download active e4
pbc tab screenshot active "C:\absolute\shot.png"
```

For structured reads, prefer `tab text --json`; use `snapshot` when refs or
control metadata are needed. Use `--trace` to collect a reproducible failure.

## Cinematic mode (beta)

Use `pbc cinematic doctor`, `pbc cinematic example <path>`, `pbc cinematic run
<script.json>`, and `pbc cinematic stitch <video> <audio>`. A cinematic script
actively controls its selected tab, so inspect the JSON first and test against a
disposable tab. Add sensitive selectors to its top-level `redact` list. Treat
the command surface and manifest schema as unstable while it is beta.

## Safety and login boundaries

Reuse the saved profile. Use the requested sign-in provider, usually Google,
when login is required. Stop for passkeys requiring the user, unknown 2FA,
payment confirmation, government ID, or legal signature. Never expose cookies,
passwords, recovery codes, or private account screenshots.

For CAPTCHA or human-verification challenges, including press-and-hold, do not
automate a solution unless the operator explicitly requests or authorizes it.
If encountered, ask whether to attempt it; remote users may not be able to use
the browser themselves. If authorized, make at most three attempts, then report
failure and any legitimate alternatives. Ordinary non-CAPTCHA press-and-hold
controls are not challenges.

Opening menus and inspecting available accounts is not the same as selecting
an account. Do not change the active account unless the user asked for it.

## Recovery

- Command drift: inspect `pbc --help`; if an update is authorized, run
  `pbc update`, then recheck help and `pbc doctor`.
- Wrong version after reinstall: run `Get-Command pbc -All` and `pbc doctor`.
  If multiple shim directories appear, rerun `setup.exe --link-global` or
  `install.ps1 -LinkGlobal` to remove stale managed PBC shims and put the active
  npm prefix first in the user `PATH`.
- CDP down: use `pbc open <url>`.
- Stale refs: take a fresh snapshot and retry once.
- Intercepted refs: inspect `pbc tab snapshot active --json` for
  `clickability: "intercepted"` and its `interceptedBy` description. Dismiss
  only a recognized dialog or overlay, take a fresh snapshot, then retry; do not
  force-click through an unknown blocker.
- Missing iframe control: run `pbc tab frames active`, then use `--frame`.
- Suspected reload: set a random page value and record
  `performance.timeOrigin`, snapshot, wait, and compare both values.

If `pbc` is not installed, use the latest release installer or follow the
source installation instructions at
`https://github.com/gaston1799/persistent-browser-cli`. Do not download or run
an installer without the user's approval. For local PBC development, run
`npm link`, `pbc --help`, and `pbc doctor` from the active checkout, then verify
the affected browser workflow against a disposable tab.
