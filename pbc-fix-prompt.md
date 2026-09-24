# pbc Fix Prompt — Work Order

You are maintaining **persistent-browser-cli** (`pbc`), a CDP-based browser
automation CLI used by an AI coding agent on Windows (cmd.exe, Chrome stable,
Playwright underneath in `tab_tools.js`). Read `pbc-problems.md` in this
folder for the full problem log with reproductions.

## Goal

Make `pbc` reliable for **SPA form automation** (Svelte/Angular/React,
anti-bot-protected dashboards) and **Windows cmd.exe usage**, without breaking
existing commands or the `data-pbc-ref` workflow.

Acceptance: after your changes, the following must work from a plain
`cmd.exe` prompt:

1. `pbc tab goto 2 "https://example.com/a?b=c"` (quoted URL) navigates
   correctly.
2. `pbc tab type 2 "input#otp" 747157` fills a Svelte-controlled OTP input
   such that the form's Submit button becomes enabled (real keystrokes).
3. `pbc tab click 2 "button:has-text('Submit')"` clicks it; refs from a
   fresh `pbc tab snapshot 2` are clickable immediately after.
4. If a `data-pbc-ref` goes stale between snapshot and click, the command
   fails fast (<5s) with a diff message (old vs new element), never looping
   30s on an invisible element.
5. `pbc doctor` exercises the same page-enumeration path as normal commands,
   and commands auto-retry transient CDP hangs (e.g. 2 retries with backoff).

## Priority (P1 first)

- **P1 — `pbc tab type <id> <ref|selector> <text> [--delay-ms N]`**
  Keystroke-level input via CDP `Input.dispatchKeyEvent` (or Playwright
  `pressSequentially`). Must register with Svelte `bind:value` and
  React controlled inputs. Default delay ~30-60ms, configurable.
- **P2 — ref stability:** pin `data-pbc-ref` to stable element identity, or
  re-resolve at action time and verify tag/id/type against the snapshot;
  on mismatch print a one-line diff and abort quickly. Add id/name/type to
  snapshot lines (already present) and make labels searchable.
- **P3 — click/fill fast-fail:** if the resolved target is invisible or
  disabled, wait at most ~5s, then error with element description instead of
  the current 30s loop.
- **P4 — arg quoting:** strip balanced surrounding quotes from positional
  arguments in `open`, `goto`, `fill`, `click`, `type` (cmd.exe passes
  `""https://...""`).
- **P5 — CDP resilience:** retry page-enumeration on `connectOverCDP`
  timeouts (2 retries, short backoff); make `doctor` use the same path;
  auto-reconnect if the CDP endpoint restarts.
- **P6 — tab ids:** warn when closing a tab invalidates other ids, or switch
  to stable ids. (Nice-to-have.)
- **P7 — text values:** `--include-values` flag on `tab text` to include
  input values (except password). (Nice-to-have.)

## Constraints

- Do not change the existing command surface semantics for scripts already
  using `pbc` (additive changes only; new flags/commands).
- Keep `data-pbc-ref` output format backward compatible (refs still print as
  `[eN]`), only the resolution/verification logic may change.
- Windows + cmd.exe quoting must keep working; no new external deps beyond
  what's already in `node_modules` (Playwright present).
- After editing, run the rebuild:
  `powershell -File D:\persistent-browser-cli\scripts\rebuild-shims.ps1`
  (add `-BuildExe` if an exe shim is in use) and smoke-test the acceptance
  cases above.

## Deliverables

1. Code changes in `cli.js` / `tab_tools.js` (or new module) implementing
   the accepted items.
2. Updated `README.md` / `TODO.md` noting the new `type` command and flags.
3. Short changelog entry at the top of `pbc-problems.md` marking which items
   were fixed and how to verify each.
