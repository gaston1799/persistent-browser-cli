# persistent-browser-cli

A Windows-focused CLI for driving a persistent Chrome profile over CDP and Playwright.

This repo is the reusable subset of the custom browser tooling:
- launch Chrome with a persistent profile
- reuse or navigate existing tabs
- inspect form controls and frames over CDP
- close duplicate tabs
- back up the persistent profile
- shut the browser down cleanly with `Browser.close`
- forward normal Playwright CLI commands while reusing the same persistent profile

## Scope

This repo intentionally does **not** include personal automation, job-search scripts, private candidate data, resumes, account exports, or site-specific application flows.

## Requirements

- Windows
- PowerShell
- Node.js / npm
- Google Chrome

## Install

```powershell
git clone <your-repo-url>
cd persistent-browser-cli
npm install
```

Optional global install from the repo folder:

```powershell
npm install -g .
```

That gives you:

```powershell
pbc --help
```

## Persistent Profile Setup

By default the CLI uses:

- Chrome executable:
  `C:\Program Files\Google\Chrome\Application\chrome.exe`
- persistent profile dir:
  `%LOCALAPPDATA%\persistent-browser-cli\profiles\default`
- backup dir:
  `%LOCALAPPDATA%\persistent-browser-cli\backups`
- CDP port:
  `9222`

You can override any of these with environment variables:

```powershell
$env:PBC_CHROME_EXE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:PBC_USER_DATA_DIR = 'D:\browser-profiles\my-profile'
$env:PBC_BACKUP_ROOT = 'D:\browser-profiles\backups'
$env:PBC_CDP_PORT = '9333'
$env:PBC_PWCLI_SESSION = 'my-browser-session'
```

## First Run

Open Chrome with the persistent profile:

```powershell
cd persistent-browser-cli
node cli.js open https://mail.google.com
```

Log in normally in that Chrome window. When Chrome is closed cleanly, the login state remains in the profile directory.

## Core Commands

Open or reuse a tab:

```powershell
pbc open https://mail.google.com
pbc open https://example.com --reuse
```

Check whether CDP is up:

```powershell
pbc cdp
```

List and reuse tabs:

```powershell
pbc tab list
pbc tab activate 2
pbc tab goto active https://mail.google.com
pbc tab close 2
pbc tab prune
```

Inspect frames and form controls:

```powershell
pbc tab frames active
pbc tab inspect active
pbc tab inspect active --frame gmail
```

Graceful shutdown:

```powershell
pbc saveandclose
```

Short alias:

```powershell
pbc sac
```

This closes tabs first and then sends DevTools `Browser.close` so Chrome can flush the persistent profile to disk without a forced kill.

Back up the profile:

```powershell
pbc backup
```

Back up after force-closing Chrome instances that are using the same profile:

```powershell
pbc backup --kill
```

## Playwright CLI Passthrough

The `pw` command forwards to `playwright-cli`, defaulting to:
- Chrome
- headed mode
- persistent profile
- the configured profile directory

Examples:

```powershell
pbc pw open https://example.com
pbc pw snapshot
pbc pw click e15
pbc pw fill e3 "hello"
pbc pw screenshot
```

If a ref-based command fails, the wrapper automatically runs a fresh `snapshot` so you can keep going.

## Recommended Workflow

1. `pbc open <url>`
2. log in or navigate manually
3. `pbc tab list`
4. `pbc tab inspect active` if you need to understand the page
5. `pbc pw ...` for interactive Playwright CLI work
6. `pbc sac` when you are done

## Notes

- Do **not** run two separate Chrome processes against the same `PBC_USER_DATA_DIR` at the same time.
- Using multiple tabs in the same browser is fine.
- The PowerShell launch/backup scripts are Windows-specific by design.
