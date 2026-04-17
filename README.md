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
pbc-cli --help
persistent-browser-cli --help
cli --help
```

For local development without a full global publish, you can also use:

```powershell
npm link
```

That creates the command shims from this working copy so you can run:

```powershell
cli open https://example.com
cli cdp
cli sac
```

`cli` is convenient, but on PowerShell it collides with the built-in `Clear-Item` alias. In practice you should use `pbc` or `pbc-cli`.

## Windows EXE Build

You can also build a Windows executable:

```powershell
npm install
npm run build:exe
```

That writes:

```powershell
dist\pbc.exe
```

Example:

```powershell
.\dist\pbc.exe --help
.\dist\pbc.exe doctor
```

Important constraints:

- The EXE is a repo-local convenience binary, not a fully standalone packaged app.
- It still expects the repo's installed dependencies to exist, so run `npm install` first.
- In practice, `dist\pbc.exe` resolves `playwright-core` from the repo's `node_modules` directory.
- The build process uses Node's single-executable application workflow plus `postject` on Node versions that do not yet support `--build-sea` directly.
- On Windows, the build may print a signature warning after injection. That is expected for a local unsigned build.

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

For machine-specific defaults that should not be committed, create `config.local.json` in the repo root. Example:

```json
{
  "USER_DATA_DIR": "C:\\Users\\yourname\\playwright-persistent-contexts\\chrome-jobhunt",
  "DEFAULT_CDP_PORT": 9223
}
```

`config.local.json` is ignored by git and is applied after built-in defaults but before environment variables.

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

Run a quick environment check:

```powershell
pbc doctor
```

This verifies the effective Chrome path, profile path, backup path, command shims, and whether the configured CDP endpoint is reachable.

List and reuse tabs:

```powershell
pbc tab list
pbc tab list --all
pbc tab activate 2
pbc tab goto active https://mail.google.com
pbc tab close 2
pbc tab prune
```

By default, `pbc tab list` hides Chrome internal/system pages like omnibox popups and extension pages. Use `--all` when you want the raw full tab list.

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
- session name `persistent-browser-cli`

It does **not** automatically force `--persistent` or `--profile`. That is intentional. The installed Playwright CLI version does not reliably hand off between a Playwright-managed browser and the separate CDP browser started by `pbc open`, and forcing the same profile directory causes browser-lock conflicts.

Examples:

```powershell
pbc pw open https://example.com
pbc pw list --all
pbc pw close-all
```

If you want a persistent Playwright profile, pass it explicitly:

```powershell
pbc pw open https://example.com --persistent --profile C:\path\to\profile
```

Do not point that at the same profile directory that `pbc open` is already using.

The `@playwright/cli` session model is version-sensitive. On some machines, `open` keeps a live session you can continue to drive; on others, the session may already be closed by the time the next command runs. Use `pbc pw list --all` to confirm the browser is actually still open before assuming follow-up commands like `snapshot` or `click` will attach.

If a ref-based command fails, the wrapper automatically runs a fresh `snapshot` so you can keep going.

## Recommended Workflow

1. `pbc open <url>`
2. log in or navigate manually
3. `pbc tab list`
4. `pbc tab inspect active` if you need to understand the page
5. `pbc pw ...` for Playwright CLI work in its own session
6. `pbc sac` when you are done

## Notes

- Do **not** run two separate Chrome processes against the same `PBC_USER_DATA_DIR` at the same time.
- Using multiple tabs in the same browser is fine.
- The PowerShell launch/backup scripts are Windows-specific by design.
- For PATH-based everyday use, `npm link` plus `pbc` / `pbc-cli` is still the cleaner workflow than calling the built EXE directly.
