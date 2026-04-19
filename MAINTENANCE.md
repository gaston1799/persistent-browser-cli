# Maintenance

This project should stay small, testable, and safe for real persistent browser profiles. Build one feature at a time, verify it against a real Chrome/CDP session, then commit and push.

## Release Flow

1. Start clean:

```powershell
git status --short
git pull --ff-only
```

2. Pick one feature or fix. Do not mix unrelated changes in the same commit.

3. Implement the change.

4. Run the baseline checks:

```powershell
node --check cli.js
node --check tab_tools.js
pbc --help
node cli.js doctor
```

5. If browser behavior changed, test with a temporary profile:

```powershell
$env:PBC_USER_DATA_DIR = "$env:TEMP\pbc-test-profile"
node cli.js open about:blank --port 9944
node cli.js cdp --port 9944
node cli.js tab list --port 9944
node cli.js sac --port 9944
Remove-Item -LiteralPath "$env:TEMP\pbc-test-profile" -Recurse -Force
Remove-Item Env:\PBC_USER_DATA_DIR
```

6. If tab interaction changed, test the CDP-native workflow:

```powershell
node cli.js open about:blank --port 9944
node cli.js tab eval active 'document.body.innerHTML = "<input aria-label=\"Name\"><button>Go</button>"; "ready"' --port 9944
node cli.js tab snapshot active --port 9944
node cli.js tab fill active e0 Naquan --port 9944
node cli.js tab click active e1 --port 9944
node cli.js tab screenshot active .\output\smoke.png --port 9944
node cli.js sac --port 9944
```

7. If the EXE path changed, rebuild and smoke-test:

```powershell
npm run build:exe
.\dist\pbc.exe --help
.\dist\pbc.exe doctor
```

8. Commit:

```powershell
git add <changed-files>
git commit -m "Short imperative summary"
git push
```

## Versioning

Use semantic versioning:

- Patch: bug fixes, docs, small reliability improvements.
- Minor: new commands, new flags, new user-facing workflows.
- Major: breaking command syntax or config behavior.

Update `package.json` before tagging:

```powershell
npm version patch --no-git-tag-version
```

or:

```powershell
npm version minor --no-git-tag-version
```

Then commit the version bump and tag:

```powershell
git add package.json package-lock.json
git commit -m "Bump version to vX.Y.Z"
git tag vX.Y.Z
git push
git push origin vX.Y.Z
```

Create the GitHub release:

```powershell
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file RELEASE_NOTES.md
```

Attach `dist\pbc.exe` only after rebuilding it from the release commit:

```powershell
npm run build:exe
gh release upload vX.Y.Z .\dist\pbc.exe
```

## Update Flow

- `pbc` should print a non-blocking notice when GitHub Releases has a newer tag.
- `pbc update --check-only` should only report status.
- `pbc update` should update the current git checkout with `git fetch --tags --prune` and `git pull --ff-only`, then reinstall npm dependencies.
- `install.ps1` is the user-local bootstrap path for fresh installs.
- `pbc install` should be the user-facing wrapper around `install.ps1`.
- `setup.exe` should be the user-facing double-click installer that bootstraps Node and then runs `install.ps1`.
- Keep `PBC_SKIP_UPDATE_CHECK=1` available for automation and offline use.

## Design Rules

- Prefer CDP-native `pbc tab ...` commands for logged-in persistent Chrome work.
- Keep `pbc pw` as passthrough only. Do not make it pretend to control the CDP browser.
- Do not launch two Chrome processes against the same `PBC_USER_DATA_DIR`.
- Never commit `config.local.json`, profile data, screenshots, logs, or private automation data.
- Keep machine-specific paths in `config.local.json` or environment variables.
- Avoid site-specific automation in this repo. This is reusable browser tooling, not a job-search script repo.
- Treat `pbc update` as a git-checkout updater, not a Windows system installer.

## Testing Checklist

Use this before pushing user-facing features:

- `node --check cli.js`
- `node --check tab_tools.js`
- `pbc --help`
- `node cli.js doctor`
- `npm run build:exe`
- `.\dist\pbc.exe --help`
- `.\dist\pbc.exe doctor`
- `.\dist\setup.exe --help`
- temporary-profile launch with a path containing spaces
- `pbc tab list`
- `pbc tab snapshot`
- `pbc tab click`
- `pbc tab fill`
- `pbc tab text`
- `pbc tab screenshot`
- `pbc sac`

## Common Failure Modes

- CDP down: run `pbc open <url>` first or check the configured port.
- Profile lock: another Chrome process is using the same user-data directory.
- Missing refs: run `pbc tab snapshot active` again after navigation or DOM changes.
- Internal tab selected: use `pbc tab list` and target the visible tab id explicitly.
- PowerShell `cli` collision: use `pbc` or `pbc-cli`, not `cli`.
- Spaces in profile path: keep `--user-data-dir` quoted in `open_persistent_chrome.ps1`.
- Installer confusion: verify both `pbc.exe` and `setup.exe` are present in the release and called out separately in notes.

## Commit Standard

Use short imperative commit messages:

- `Add status command`
- `Fix profile launch quoting`
- `Filter internal Chrome tabs`
- `Document release flow`

One feature per commit. If a change needs risky refactoring, commit the refactor separately from behavior changes.
