# Following a run in the terminal

`grad train --wait`, `grad runs watch RUN`, `grad runs wait` and `grad runs resume --wait` open this view when stdin and stdout are a terminal. The phase line says what the run is doing and for how long: waiting for a GPU (with the number of workers online once the server reports it), starting (on a named GPU when known), loading the model, training, evaluating, uploading. After an interruption (the GPU was reclaimed, the worker was lost) the event log carries the server's message and the phase line says where the next attempt resumes. Servers that don't report lifecycle phases yet get the same view, with the phase derived from the run's status and metric stream.

The screen is calm on purpose: plain text in your terminal's own colours, secondary text dimmed, one accent (cyan) for what is moving, magenta for the eval series, and green, yellow and red only for state. It never paints a background, so it reads the same on light and dark themes; `NO_COLOR` turns colour off. Frames are drawn inside synchronized updates and only changed cells are written, so nothing flickers, over SSH and in tmux too. The plain eval loss lives in the chart and the checkpoints table; the event log keeps to phases, attempts, warnings, worker messages and recipe metrics (offload and saving for the router, accuracy and ECE for decision models, recall@k for embeddings).

The capture below is a `TestBackend` dump of a recorded run from the test harness (reference worker, `test/tiny-qwen3`, hence the tiny model and the high throughput), at step 640 of 1,062 in a 100x30 terminal. It is the `wide` render snapshot in `cli/tests/snapshots/tui/`, and a test keeps this page in sync with it.

```text
 support-sft  run_c0eec7e24c43a921208e88c2                             started 2026-11-27 14:11 UTC
 recipe sft   model test/tiny-qwen3   dataset support-prod@1                            elapsed 10s

 ⠼ Training  for 10s                                                                   attempt 1/10

 step  640 / 1,062       ━━━━━━━━━━━━━━━━━━━━━━━━━─────────────────   60%   262.7k tok/s  ·  ETA 7s
 cost  $0.0096 / $0.05   ━━━━━━━━──────────────────────────────────   19%   9.6k tokens

 ╭ Loss ──────────────────────────────────── ━ train 0.6194   ━ eval 0.6195   ● best 0.6195 @ 640 ╮
 │ 0.699 ⠤⢀⡀                                                                                      │
 │         ⠈⠑⠢⠤⣀                                                                                  │
 │              ⠉⠒⠤⠤⣀                                                                             │
 │                  ⠈⠉⠒⠤⢄⣀                                                                        │
 │                       ⠈⠉⠒⠤⢄⣀⡀                                                                  │
 │ 0.656                       ⠈⠉⠒⠢⠤⢄⡀                                                            │
 │                                   ⠈⠑⠢⠤⠤⠤⣀⡀                                                     │
 │                                        ⠈⠈⠈⠉⠒⠒⠤⢄⣀⣀⡀                                             │
 │                                                 ⠉⠉⠉⠑⠒⠤⢄⣀⣀⣀•                                    │
 │ 0.614                                                     ⠉                                    │
 │       0                                         step                                     1,062 │
 │    lr  ▃▆█▇▇▇▇▇▇▇▇▇▇▆▆▆▆▆▆▆▆▆▆▅▅▅▅▅▅▅▅▅▄▄▄▄▄▄▄▄▄▄▄▃▃▃▃▃▃▃▃▃ 3.6e-5                             │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────╯
 ╭ Checkpoints ───────────────────╮ ╭ Events ─────────────────────────────────────────────────────╮
 │    step  eval loss             │ │  00:00  Run created                                         │
 │     580  0.6237                │ │  00:00  Starting                                            │
 │     600  0.6223                │ │  00:00  Training                                            │
 │     620  0.6209                │ │                                                             │
 │     640  0.6195   ● best       │ │                                                             │
 ╰────────────────────────────────╯ ╰─────────────────────────────────────────────────────────────╯
 q detach  c cancel  l logs  ? help                                                          ● live
```

Below 80x24 the view drops the panels for a compact layout:

```text
support-sft  run_c0eec7e24c43a921208e88c2
sft  ·  test/tiny-qwen3  ·  support-prod@1
⠼ Training  for 10s  ·  attempt 1/10
step  640 / 1,062       ━━━━━━━━━━━━━━━━━━────────────   60%
cost  $0.0096 / $0.05   ━━━━━━────────────────────────   19%
      262.7k tok/s  ·  ETA 7s  ·  9.6k tokens
loss  0.6194  best 0.6195 @ 640  █▇▇▆▆▆▅▅▅▄▄▄▃▃▃▃▂▂▂▂▁▁▁▁
────────────────────────────────────────────────────────────
 00:00  Run created
 00:00  Starting
 00:00  Training






q detach  c cancel  l logs  ? help
```

| Key            | Action                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `q` / `Ctrl-C` | Detach (exit `130`). The run keeps going; reattach with `grad runs watch`. |
| `c`            | Cancel the run, after a `y` to confirm.                                    |
| `l`            | Show or hide the full event log.                                           |
| `?`            | Help.                                                                      |

When the run ends, the view closes and the usual summary prints on the normal screen: time, tokens and cost, the eval report, the artifact, and the download and deploy commands. `--json`, `--plain` or `GRAD_NO_TUI=1`, and any non-terminal output (CI logs, pipes), keep the plain line readout.

The view is `cli/src/tui.rs`. Its render tests replay `cli/tests/fixtures/tui/sft-reference-run.json` (a recording of the run events stream) into the wide, standard (80x24), narrow, waiting, interrupted and finished layouts; `GRAD_UPDATE_SNAPSHOTS=1 cargo test -p grad-cli tui` rewrites the snapshots and the two captures on this page.
