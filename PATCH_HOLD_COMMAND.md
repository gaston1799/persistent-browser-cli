# PBC Patch Work Order: `tab hold` + `tab test-hold` commands

You are maintaining **persistent-browser-cli** (`pbc`), a CDP-based browser automation CLI used by an AI coding agent on Windows (cmd.exe, Chrome stable, Playwright underneath in tab_tools.js). This work order adds two new native commands.

## Goal

Add:

1. `pbc tab hold <id|match|active> <ref|selector|text> [--hold-ms N] [--until-gone [<selector>]] [--until-visible <selector>] [--until-text <text>] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]`
   Press and physically hold the target (real mouse events) for a minimum duration and/or until a DOM condition is met, then release.
2. `pbc tab test-hold <id|match|active> <ref|selector|text> [--hold-ms N] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]`
   Press and hold while a MutationObserver records DOM changes; release shortly after the first change (~400ms settle) and print what changed (removed/added nodes, text changes, attribute changes).

Use case: long-press UI interactions, hold-to-confirm buttons, and discovering what a hold does to the DOM.

## Current state (VERIFIED 2026-08-15)

- `D:\persistent-browser-cli\tab_tools.js` **already contains the complete implementations** (verify with `node --check tab_tools.js`; it passes):
  - `holdTab(port, token, target, options)` at ~line 823
  - `testHoldTab(port, token, target, options)` at ~line 884
  - helpers `clampHoldMs`, `holdConditionMet`, `holdConditionName`, `installHoldObserver`, `holdObserverCount`, `readHoldMutations`
  - exported: `holdTab`, `testHoldTab` in `module.exports`
- `D:\persistent-browser-cli\cli.js` is **UNTOUCHED** — this is your main job (4 edits below).
- The repo has unrelated uncommitted work from a previous fix pass (P1-P8). Do NOT touch it. Do NOT git commit anything.

## Behavior contract (already implemented in tab_tools.js — do not change it)

- `hold`: mouse.move to element center -> mouse.down -> poll every 50ms -> release on: (a) condition met (after min hold), (b) min hold elapsed when no condition, (c) deadline = max(minHold, timeoutMs; default timeout 5000ms). Returns `{ held, mode, heldMs, condition: "hold"|"until-gone"|"until-visible"|"until-text"|"timeout", url }`.
- `untilGone` semantics: `undefined` = not watching; `""` = release when the held element itself leaves the DOM; `"<selector>"` = release when that selector matches nothing.
- `test-hold`: installs a MutationObserver on `document.documentElement` (subtree/childList/characterData/attributes), holds, releases ~400ms after the first recorded change, returns `{ held, mode, heldMs, firstChangeAt, changed, mutations: string[] (deduped, max 40) }`.

## cli.js — apply these 4 edits exactly

### Edit 1 — import the new functions
In the `require("./tab_tools")` block, after `gotoTab,` add:
```js
  holdTab,
  testHoldTab,
```

### Edit 2 — help text
After the `pbc tab click ...` usage line add these two lines:
```
  pbc tab hold <id|match|active> <ref|selector|text> [--hold-ms N] [--until-gone [<selector>]] [--until-visible <selector>] [--until-text <text>] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab test-hold <id|match|active> <ref|selector|text> [--hold-ms N] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]
```

### Edit 3 — positionalArgs flag list
`positionalArgs` skips flag+value pairs via a hardcoded list. Extend the list so these new flags' values never leak into positional args. Change the line that currently ends with `|| value === "--timeout" || value === "--delay-ms") {` to end with:
```js
|| value === "--timeout" || value === "--delay-ms" || value === "--hold-ms" || value === "--until-gone" || value === "--until-visible" || value === "--until-text" || value === "--timeout-ms") {
```

### Edit 4 — dispatch blocks
Insert between the `click` block and the `fill` block (after click's `process.exit(0);` and closing `}`):
```js
    if (sub === "hold") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const target = args.slice(1).join(" ");
      const frame = readArg("--frame", argv);
      const holdMs = readArg("--hold-ms", argv);
      const untilGone = hasFlag("--until-gone", argv) ? (readArg("--until-gone", argv) || "") : undefined;
      const untilVisible = readArg("--until-visible", argv);
      const untilText = readArg("--until-text", argv);
      const timeoutMs = readArg("--timeout-ms", argv);
      if (!token || !target) {
        console.log("Usage: pbc tab hold <id|match|active> <ref|selector|text> [--hold-ms N] [--until-gone [<selector>]] [--until-visible <selector>] [--until-text <text>] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-hold",
        argv,
      }, () => holdTab(port, token, target, { frame, holdMs, untilGone, untilVisible, untilText, timeoutMs }));
      console.log(`[pbc] Held ${result.mode} ${JSON.stringify(result.held)} for ${result.heldMs}ms (${result.condition}).`);
      process.exit(0);
    }

    if (sub === "test-hold") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const target = args.slice(1).join(" ");
      const frame = readArg("--frame", argv);
      const holdMs = readArg("--hold-ms", argv);
      const timeoutMs = readArg("--timeout-ms", argv);
      if (!token || !target) {
        console.log("Usage: pbc tab test-hold <id|match|active> <ref|selector|text> [--hold-ms N] [--timeout-ms N] [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-test-hold",
        argv,
      }, () => testHoldTab(port, token, target, { frame, holdMs, timeoutMs }));
      console.log(`[pbc] Test-held ${result.mode} ${JSON.stringify(result.held)} for ${result.heldMs}ms. Changes: ${result.changed ? result.mutations.length : 0}`);
      if (result.changed) {
        for (const line of result.mutations) console.log(`  - ${line}`);
      } else {
        console.log("  (no DOM changes observed)");
      }
      process.exit(0);
    }
```

Notes on parsing conventions:
- `readArg(flag, argv)` returns `null` when the flag is absent or its next token starts with "-".
- `hasFlag("--until-gone", argv)` + `readArg(...) || ""` distinguishes "flag present with no value" (-> `""` = release when the held element itself is gone) from "flag absent" (-> `undefined` = no until-gone condition). Keep this exact distinction.
- Mirror the `click` block's structure (runWithTrace wrapping, process.exit(0), [pbc] output line).

## Docs (small)

1. Add a changelog row at the top of the table in `pbc-problems.md`:
   `| P11 | FIXED | New tab hold / test-hold commands: real mouse press-and-hold with --until-gone/--until-visible/--until-text release conditions; test-hold reports DOM mutations via MutationObserver. | hold a button and verify DOM-change reporting; --until-gone releases when the element leaves the DOM. |`
2. Add one line to `TODO.md` noting the hold commands are implemented.
3. If `README.md` contains a command list, add the two commands there; otherwise leave README alone.

## Rebuild + verify

1. `node --check cli.js` and `node --check tab_tools.js` — both must exit 0.
2. `powershell -File D:\persistent-browser-cli\scripts\rebuild-shims.ps1` — must print `Rebuild complete.` and `pbc doctor` must be green. If CDP is down, run `pbc open https://example.com` first to start Chrome, then doctor.
3. Smoke tests (Chrome must be running; the shell is cmd.exe, so avoid inline quotes in args — selectors like `#b` are safe):
   - Create three test pages under `D:\persistent-browser-cli\output\`:
     - `hold-test.html`: `<button id="b" style="width:240px;height:90px">HOLD</button><div id="o"></div><script>b.onpointerdown=()=>{b._t=performance.now()};b.onpointerup=()=>{o.textContent=((performance.now()-b._t)/1000).toFixed(2)}</script>`
     - `hold-gone.html`: `<button id="b" onpointerdown="setTimeout(()=>b.remove(),400)">GO</button>`
     - `hold-mutate.html`: `<button id="b" style="width:240px;height:90px" onpointerdown="setTimeout(()=>{b.textContent='VERIFYING';const d=document.createElement('div');d.id='done';d.textContent='ok';document.body.appendChild(d)},300)">HOLD</button>`
   - Run and record actual outputs:
     - `pbc tab goto 0 "file:///D:/persistent-browser-cli/output/hold-test.html"` then `pbc tab hold 0 "#b" --hold-ms 1200` -> expect `for ~1200ms (hold)`
     - Verify duration via eval: `pbc tab eval 0 --base64 <base64 of "document.getElementById('o').textContent"> --json` -> expect `"1.2"` (or ~1.2)
     - goto `hold-gone.html`, `pbc tab hold 0 "#b" --hold-ms 10000 --until-gone` -> expect condition `until-gone`, heldMs roughly 400-900
     - goto `hold-mutate.html`, `pbc tab test-hold 0 "#b" --hold-ms 10000` -> expect `Changes: >= 1` and a mutation line mentioning a text change or `added <div#done>`
     - `pbc tab hold 0` (no target) -> expect Usage error, exit code 1
4. Do NOT run `pbc sac` unless you started the browser yourself; leave the browser running.

## Constraints

- Additive only. Do not change existing command semantics or the `[eN]` ref format.
- No new dependencies (Playwright is already present).
- Windows cmd.exe quoting must keep working (repo convention: strip balanced surrounding quotes; avoid needing inline JS in shell args — use `--base64` where page JS is required, as in the smoke tests above).
- Do not git commit. Leave the working tree dirty with your changes.

## Deliverables

1. `cli.js` patched (4 edits) and `node --check` passes on both files.
2. Docs updated (`pbc-problems.md` P11 row, `TODO.md` note, README only if it lists commands).
3. Rebuild run, `pbc doctor` green.
4. All 5 smoke tests pass — report the actual command outputs.
