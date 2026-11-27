# Following a run in the terminal

`grad train --wait`, `grad runs watch RUN`, `grad runs wait` and `grad runs resume --wait` open this view when stdin and stdout are a terminal. It works over SSH and in tmux, redraws only the cells that change (inside synchronized updates, so nothing flickers), and uses a few named ANSI colours on your terminal's own background, so it follows your light or dark theme. `NO_COLOR` turns colour off.

The capture below is a `TestBackend` dump of a recorded run from the test harness (reference worker, `test/tiny-qwen3`, hence the tiny model and the high throughput), at step 640 of 1,062 in a 100x30 terminal. It is the `wide` render snapshot in `cli/tests/snapshots/tui/`, and a test keeps this page in sync with it.

```text
 support-sft  run_c932533fbc670fc82bf20da3                      started 2026-11-27 13:45 UTC  ·  7s
 sft  ·  test/tiny-qwen3  ·  support-prod@1

 ⠙ Training  for 7s                                                                    attempt 1/10

 step  640 / 1,062       ━━━━━━━━━━━━━━━━━━━━━━━━━─────────────────   60%   256.4k tok/s  ·  ETA 4s
 cost  $0.0096 / $0.05   ━━━━━━━━──────────────────────────────────   19%   9.6k tokens

 ╭ Loss ──────────────────────────────────── ━ train 0.6194   ━ eval 0.6195   ● best 0.6195 @ 640 ╮
 │ 0.699│⠤⠠⣀                                                                                      │
 │      │   ⠉⠒⠒⠤⣀                                                                                 │
 │      │        ⠉⠒⠒⠤⢄⡀                                                                           │
 │      │             ⠈⠑⠢⠤⢄⣀⡀                                                                     │
 │      │                   ⠉⠑⠒⠢⠤⣀⡀                                                               │
 │      │                         ⠈⠉⠑⠒⠤⢄⣀⡀                                                        │
 │      │                                ⠉⠉⠒⠒⠒⠤⠤⣀⡀                                                │
 │      │                                        ⠈⠉⠉⠑⠒⠢⠤⠤⢄⣀⣀⣀•                                    │
 │ 0.614│                                                   ⠉⠉                                    │
 │      └──────────────────────────────────────────────────────────────────────────────────────── │
 │      0                                                                                   1,062 │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────╯
      lr  ▃▆█▇▇▇▇▇▇▇▇▇▆▆▆▆▆▆▆▆▆▅▅▅▅▅▅▅▅▅▄▄▄▄▄▄▄▄▄▄▃▃▃▃▃▃▃▃▃▂▂▂ 3.6e-5
 ╭ Checkpoints ───────────────────╮╭ Events ──────────────────────────────────────────────────────╮
 │    step  score                 ││   00:07  Eval at step 560 · loss 0.6253                      │
 │     580  0.6237                ││   00:07  Eval at step 580 · loss 0.6237                      │
 │     600  0.6223                ││   00:07  Eval at step 600 · loss 0.6223                      │
 │     620  0.6209                ││   00:07  Eval at step 620 · loss 0.6209                      │
 │     640  0.6195   ● best       ││   00:07  Eval at step 640 · loss 0.6195                      │
 ╰────────────────────────────────╯╰──────────────────────────────────────────────────────────────╯
 q detach   c cancel   l logs   ? help                                                       ● live
```

Below 80x22 the view drops the panels for a compact layout:

```text
support-sft  run_c932533fbc670fc82bf20da3
sft  ·  test/tiny-qwen3  ·  support-prod@1
⠙ Training  for 7s  attempt 1/10
step  640 / 1,062       ━━━━━━━━━━━━━━━━━━────────────   60%
cost  $0.0096 / $0.05   ━━━━━━────────────────────────   19%
      256.4k tok/s  ·  ETA 4s  ·  9.6k tokens
loss  0.6194  best eval 0.6195  █▇▇▆▆▆▅▅▅▄▄▄▃▃▃▂▂▂▁▁▁▁▁

  00:06  Eval at step 480 · loss 0.632
  00:06  Eval at step 500 · loss 0.6302
  00:06  Eval at step 520 · loss 0.6285
  00:06  Eval at step 540 · loss 0.6268
  00:07  Eval at step 560 · loss 0.6253
  00:07  Eval at step 580 · loss 0.6237
  00:07  Eval at step 600 · loss 0.6223
  00:07  Eval at step 620 · loss 0.6209
  00:07  Eval at step 640 · loss 0.6195
q detach   c cancel   l logs   ? help
```

| Key            | Action                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `q` / `Ctrl-C` | Detach (exit `130`). The run keeps going; reattach with `grad runs watch`. |
| `c`            | Cancel the run, after a `y` to confirm.                                    |
| `l`            | Show or hide the full event log.                                           |
| `?`            | Help.                                                                      |

When the run ends, the view closes and the usual summary prints on the normal screen: time, tokens and cost, the eval report, the artifact, and the download and deploy commands. `--json`, `--plain` or `GRAD_NO_TUI=1`, and any non-terminal output (CI logs, pipes), keep the plain line readout.

The view is `cli/src/tui.rs`. Its render tests replay `cli/tests/fixtures/tui/sft-reference-run.json` into the wide, narrow, waiting, interrupted and finished layouts; `GRAD_UPDATE_SNAPSHOTS=1 cargo test -p grad-cli tui` rewrites the snapshots (then copy the wide one here).
