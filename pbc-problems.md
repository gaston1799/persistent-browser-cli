# pbc (persistent-browser-cli) â€” Problems Log

## Changelog â€” 2026-08-14 fix pass

| # | Status | Fix | How to verify |
|---|--------|-----|---------------|
| P13 | FIXED | CDP hangs from wedged renderers: `enumeratePages` now timeboxes per-tab title/focus checks (1.2s each) and flags stalled tabs; new `pbc tab targets` (HTTP /json, never hangs) and `pbc tab heal` (closes stalled tabs at browser level). | Open a heavy SPA until `tab list` shows [STALLED], then `pbc tab heal` clears it and commands work again. |
| P12 | FIXED | New `pbc tab press <id|match|active> <key>` command (was documented but never implemented): sends a real key press via Playwright keyboard (Enter/Escape/Tab/Arrows/etc.). | `pbc tab press 0 Enter` inside an input adds a tag / confirms a react-select option. |
| P11 | FIXED | New tab hold / test-hold commands: real mouse press-and-hold with --until-gone/--until-visible/--until-text release conditions; test-hold reports DOM mutations via MutationObserver. | hold a button and verify DOM-change reporting; --until-gone releases when the element leaves the DOM. |
| P1 | FIXED | New `pbc tab type <id> <ref|selector|label> <text> [--delay-ms N] [--clear]` types via real keystrokes (Playwright `pressSequentially`). | Fill a Svelte `bind:value` OTP input; the Submit button becomes enabled. |
| P2/P3 | FIXED | `snapshot` clears stale `data-pbc-ref` before re-assigning and persists a ref index; `click`/`fill`/`type` verify tag/id/name/type at action time. Stale refs fail fast with a one-line diff; invisible/disabled targets fail fast with an element description. | Snapshot, mutate the DOM, click the old ref â†’ diff message, no 30s wait. |
| P4 | FIXED | Balanced surrounding quotes are stripped from positional args (`open`/`goto`/`fill`/`click`/`type`). | `pbc tab goto 2 "https://example.com/a?b=c"` from cmd.exe navigates correctly. |
| P5 | FIXED | `connectPages` retries (2 retries + backoff) and bounds page enumeration with a timeout; `pbc doctor` enumerates pages over CDP using the same path as commands. | Run `pbc doctor` with Chrome up; restart Chrome and re-run a command. |
| P6 | FIXED | `pbc tab close` warns when other open tab ids will be renumbered. | Close a non-highest tab with multiple tabs open. |
| P7 | FIXED | `pbc tab text --include-values` appends non-password input values to the dump. | `pbc tab text active --include-values` on a page with filled inputs. |
| P8 | FIXED (with P2/P3) | Click/fill/type fail fast (â‰¤5s) with element-state diagnostics instead of the 30s actionability loop. | Click a hidden/disabled element â†’ fast error with description. |
| P10 | FIXED | Inline tab eval JS containing backticks/${} corrupted (template-literal embedding); cmd.exe quote mangling surfaced raw ReferenceError with no guidance. Now concat-embedded + SyntaxError hint suggesting --base64/--file. | quote-heavy inline JS from cmd.exe; --base64 path unaffected. |
| P9 | OPEN | A documented "human mode" (real key events + pointer coordinates + natural delays) remains future work; `tab type --delay-ms` covers part of it. | â€” |

Observed during real automation sessions (2026-08-14). All items were hit in
production use driving SPA dashboards (Gmail, Google Cloud console,
Programmable Search Engine, Brave Search API dashboard). Each item lists the
symptom, root cause, and reproduction path. Severity = time lost.

---

## P1. No keystroke-level text input command (only `fill`)

- **Symptom:** `pbc tab fill` set the DOM `value` of an OTP input to
  `747157`, but the Svelte form's Submit button stayed `disabled`. Svelte's
  `bind:value` never saw the change, so the form considered the field empty.
- **Root cause:** `fill` uses Playwright `locator.fill()` (value setter +
  synthetic events). Many Svelte/Angular/React controlled inputs require real
  key events (`keydown`/`keypress`/`keyup`/`beforeinput`) to update framework
  state â€” exactly the behavior anti-bot pages also expect.
- **Workaround used:** user typed the OTP by hand. Not acceptable long-term.
- **Fix wanted:** `pbc tab type <id> <ref|selector> <text>` that types text
  one keystroke at a time via CDP `Input.dispatchKeyEvent`/Playwright
  `pressSequentially`, with configurable delay (e.g. `--delay-ms 50`).

## P2. `tab eval` clicks are ignored by SPA/anti-bot handlers

- **Symptom:** `document.querySelector(...).click()` via `tab eval` did
  nothing on reCAPTCHA-protected forms (Google PSE "create engine" flow) and
  on Brave's subscribe modal. Page state unchanged, no error.
- **Root cause:** synthetic `.click()` lacks trusted-event flags / correct
  pointer coordinates; SPA frameworks and bot protection ignore it.
- **Fix wanted:** (a) document loudly that `tab click` (CDP) is the only
  supported click path; (b) make `tab click` accept selectors and labels
  robustly (see P3).

## P3. `data-pbc-ref` refs are positional and go stale after re-render

- **Symptom:** snapshot showed `[e27] = input#tos_accepted (checkbox)`.
  Immediately clicking `e27` resolved to a *hidden* `Free` preset-chip
  (`<button data-pbc-ref="e27" class="preset-chip ... active">`), not the
  checkbox. Click timed out 30s on an invisible element.
- **Root cause:** refs are assigned in snapshot order; a Svelte re-render
  between snapshot and click renumbered/reassigned the same ref number to a
  different element. Ref numbers are not stable identifiers.
- **Workaround used:** re-snapshot and click instantly â€” still racy.
- **Fix wanted:** pin refs to stable identities (element id/name/selector
  hash) or re-resolve at action time and verify the resolved element matches
  the snapshot's recorded tag/id/type; fail fast with a diff message
  ("ref e27 now points to BUTTON 'Free', was INPUT#tos_accepted").
  Also: include stable attributes (id, name, type, label) in snapshot lines
  so callers can target by them.

## P4. cmd.exe quoting breaks `goto`/`open` with quoted URLs

- **Symptom:** `pbc tab goto 2 "https://..."` â†’
  `Cannot navigate to invalid URL`, log shows `navigating to ""https://...""`
  (literal quotes passed through).
- **Root cause:** cmd.exe passes quotes; the arg parser doesn't strip
  balanced surrounding quotes from URL/argument values.
- **Fix wanted:** strip matching outer quotes from every positional arg
  (goto/open/fill/click/type) before use; accept `--` separator.

## P5. Intermittent CDP hangs with no auto-recovery

- **Symptom:** `browserType.connectOverCDP: Timeout 10000ms exceeded` â€”
  websocket connects, then page enumeration hangs. `pbc doctor` reports
  everything OK (it uses a different probe). Retrying the same command
  eventually works; one session needed a manual browser restart.
- **Fix wanted:** (a) retry/backoff on page-list timeout; (b) doctor should
  actually enumerate pages via the same path commands use; (c) auto-reconnect
  with the same profile when the CDP browser restarts.

## P6. Tab ids renumber when a tab closes

- **Symptom:** closing tab 1 makes tab 2 become tab 1; stored refs/ids
  silently point at the wrong tab.
- **Workaround (user rule):** always close the highest id first.
- **Fix wanted:** warn when a close invalidates other tabs' ids, or keep
  stable tab ids (e.g. `T-<guid>`) alongside the positional index.

## P7. `tab text` omits values inside inputs/dialogs

- **Symptom:** API keys and OTP codes were not present in `tab text` output
  (input values, clipboard-style masked fields); had to extract with
  `tab eval` regex.
- **Fix wanted:** `--include-values` flag that appends `input[type!=password]`
  values and `value` attributes to the text dump.

## P8. Click retry burns 30s on hidden/stale elements

- **Symptom:** clicking a stale ref (P3) or a disabled button loops
  `waiting for element to be visible, enabled and stable` for the full 30s
  timeout per attempt, with no early diagnostic.
- **Fix wanted:** when a click target is invisible/disabled, fail fast
  (e.g. 5s) and print what the element is and why it can't be clicked.

## P9. No documented "human input" mode

- The registration/login flows that matter most (reCAPTCHA, OTP, spend-limit
  modals) are exactly where synthetic input fails. A single documented
  "human mode" (real key events + pointer coordinates + natural delays)
  would prevent the P1/P2/P8 class of failures entirely.

---

## Environment notes

- Windows 10/11, cmd.exe (default wrapper shell), Chrome stable.
- Playwright is used under the hood (`tab_tools.js` logs show
  `locator.click`, `locator.fill`).
- Session wrapper runs commands via `cmd /d /s /c` â€” quoting matters (P4).
