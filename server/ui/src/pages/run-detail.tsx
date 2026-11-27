import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Artifact, Checkpoint, Run } from "@sdk/generated/models.js";

import { LineChart, smooth, type ChartColor } from "../components/chart.js";
import { IconChevron, IconDownload, IconPlay, IconRuns as IconChart, IconStop } from "../components/icons.js";
import { Badge, Banner, Card, Command, Confirm, CopyButton, Empty, ErrorBanner, Meter, SkeletonRows, Stat, StatusBadge, useToast } from "../components/ui.js";
import { CODEC, convertKeys, errorMessage, isTerminalRun, lifecycleOf, useApi, type RunLifecycle, type RunPhase } from "../lib/api.js";
import { evalLossOf, foldCheckpoints, PHASE_LABEL, REASON_LABEL, type RunStreamState, type TimelineItem } from "../lib/events.js";
import { ago, bytes, compact, dateTime, duration, int, num, time, toYaml, usd } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { renderReport } from "../lib/report.js";
import { Link } from "../lib/router.js";
import { useRunStream } from "../lib/stream.js";

const RESUMABLE = new Set(["failed", "cancelled", "stopped_budget"]);

export const RunDetailPage = ({ id }: { id: string }) => {
  const api = useApi();
  const now = useNow(5000);
  const { state: stream, error: streamError } = useRunStream(api, id);
  const polled = useResource((signal) => api.client.getRun(id, { signal }), [id], {
    pollMs: (r) => (r && isTerminalRun(r) ? undefined : 3000),
  });
  // The stream's final event is the freshest copy once the run ends.
  const run = pickNewest(polled.data, stream.final);
  const [dialog, setDialog] = useState<"cancel" | "resume" | null>(null);

  if (!run) {
    return (
      <div className="page">
        <Crumbs name={id} />
        {polled.error ? <ErrorBanner error={polled.error} onRetry={polled.reload} /> : <div className="skeleton title" aria-label="Loading run" />}
      </div>
    );
  }

  const life = lifecycleOf(run);
  const active = !isTerminalRun(run);
  const started = Date.parse(run.createdAt);
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : now;

  return (
    <div className="page">
      <Crumbs name={run.name} />
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {run.name}
            <StatusBadge status={run.status} />
            {active && <span className={`led${streamError ? " off" : ""}`}>{streamError ? "offline" : "live"}</span>}
          </h1>
          <div className="page-sub">
            <span className="group">
              <span className="mono">{run.id}</span>
              <CopyButton text={run.id} label="Copy run id" />
            </span>
            <span className="sep" />
            <span className="group">
              <span className="chip">{run.recipeKind}</span>
              <span className="mono">{run.resolvedConfig.model}</span>
            </span>
            <span className="sep" />
            <span className="group">
              <Link className="link" href={`/datasets/${encodeURIComponent(run.datasetName)}`}>
                {run.datasetName}
              </Link>
              <span className="faint">v{run.datasetVersion}</span>
            </span>
            <span className="sep" />
            <span title={dateTime(run.createdAt)}>created {ago(run.createdAt, now)}</span>
            <span className="sep" />
            <span>
              {active ? (run.status === "queued" ? "queued for" : "running for") : "took"} {duration(ended - started)}
            </span>
          </div>
        </div>
        <div className="actions">
          {active && (
            <button type="button" className="btn danger" onClick={() => setDialog("cancel")}>
              <IconStop /> Cancel
            </button>
          )}
          {RESUMABLE.has(run.status) && (
            <button type="button" className="btn" onClick={() => setDialog("resume")}>
              <IconPlay /> Resume
            </button>
          )}
        </div>
      </div>

      {run.status === "failed" && run.error && <Banner>{run.error}</Banner>}
      {run.status === "stopped_budget" && (
        <Banner tone="warn">
          Stopped at the cost cap of {usd(run.maxCostUsd)}. Resume with a higher cap to continue from the last checkpoint.
        </Banner>
      )}
      {streamError ? <Banner tone="warn">Live updates stopped: {errorMessage(streamError)}</Banner> : null}

      <Lifecycle run={run} life={life} stream={stream} now={now} />
      <RunStats run={run} stream={stream} />
      {stream.series.step.length > 0 ? (
        <Charts run={run} stream={stream} />
      ) : (
        <Card title="Metrics">
          <Empty title={active ? "Waiting for the first step" : "No metrics were recorded"} icon={<IconChart />}>
            {active ? "Loss, learning rate, throughput and cost charts appear once training starts." : "This run ended before its first training step."}
          </Empty>
        </Card>
      )}

      <div className="split">
        <div className="stack">
          <Checkpoints run={run} checkpointEvents={stream.timeline.filter((t) => t.kind === "checkpoint").length} onPromoted={polled.reload} />
          {run.evalReport && <EvalReportCard run={run} />}
          {run.artifactId && <ArtifactCard id={run.artifactId} />}
          <ConfigCard run={run} />
        </div>
        <Timeline items={stream.timeline} />
      </div>

      {dialog === "cancel" && (
        <Confirm
          title="Cancel this run?"
          danger
          confirm="Cancel run"
          body={<p>The worker stops at its next heartbeat. Checkpoints already saved are kept, and you can resume later.</p>}
          onConfirm={async () => {
            await api.client.cancelRun(run.id);
            polled.reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "resume" && <ResumeDialog run={run} onDone={polled.reload} onClose={() => setDialog(null)} />}
    </div>
  );
};

const pickNewest = (a: Run | undefined, b: Run | null): Run | undefined => {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a;
};

const Crumbs = ({ name }: { name: string }) => (
  <div className="crumbs">
    <Link href="/runs">Runs</Link>
    <IconChevron width={12} height={12} />
    <span>{name}</span>
  </div>
);

// ------------------------------------------------------------ lifecycle

const GROUPS: { label: string; phases: RunPhase[] }[] = [
  { label: "Queued", phases: ["queued", "waiting_for_compute"] },
  { label: "Starting", phases: ["starting", "loading_model"] },
  { label: "Training", phases: ["training", "evaluating", "checkpointing"] },
  { label: "Uploading", phases: ["uploading", "completing"] },
  { label: "Done", phases: [] },
];

export const derivePhase = (run: Run, life: RunLifecycle, streamPhase: RunPhase | undefined): RunPhase | null => {
  const phase = streamPhase ?? life.phase;
  if (phase) return phase;
  if (run.status === "queued") return "queued";
  if (run.status === "running") return run.currentStep > 0 ? "training" : "starting";
  return null;
};

const Lifecycle = ({ run, life, stream, now }: { run: Run; life: RunLifecycle; stream: RunStreamState; now: number }) => {
  const active = !isTerminalRun(run);
  const phase = active ? derivePhase(run, life, stream.phase?.phase) : null;
  const groupIdx = run.status === "completed" ? GROUPS.length - 1 : phase ? GROUPS.findIndex((g) => g.phases.includes(phase)) : GROUPS.findIndex((g) => g.phases.includes(life.phase ?? "training"));
  const since = stream.phase?.since ?? life.phaseSince;
  const progress = run.totalSteps > 0 ? run.currentStep / run.totalSteps : 0;
  const workersOnline = stream.phase?.workersOnline ?? life.workersOnline;
  const autoscaling = stream.phase?.autoscaling ?? life.autoscaling;
  const failed = run.status === "failed" || run.status === "cancelled" || run.status === "stopped_budget";

  const headline = phase ? PHASE_LABEL[phase] : run.status === "completed" ? "Completed" : failed ? `Ended ${run.status === "failed" ? "with an error" : run.status === "cancelled" ? "by cancellation" : "at the cost cap"}` : "—";
  const stepState = (i: number) => (i === groupIdx ? "now" : i < groupIdx || run.status === "completed" ? "done" : "");
  return (
    <section className="card" aria-label="Lifecycle">
      <div className="card-body lifecycle">
        <div className="lifecycle-head">
          <div className="lifecycle-phase">
            <span className="now">{headline}</span>
            {phase && since && <span className="muted">for {duration(now - Date.parse(since))}</span>}
            {stream.gpu && (
              <span className="chip">
                {stream.gpu.name} · {stream.gpu.memoryGb} GB
              </span>
            )}
          </div>
          <div className="lifecycle-figures">
            <span>
              <span className="muted">Step </span>
              <b>{int(run.currentStep)}</b>
              <span className="faint"> / {int(run.totalSteps)}</span>
              {run.totalSteps > 0 && <span className="faint"> · {Math.floor(progress * 100)}%</span>}
            </span>
            <span title="Attempts started; attempts whose compute was reclaimed don't count toward the failure cap.">
              <span className="muted">Attempt </span>
              <b>{Math.max(run.attempt, 1)}</b>
              <span className="faint"> / {run.maxAttempts}</span>
            </span>
          </div>
        </div>
        <ol className={`steps${failed ? " failed" : ""}${run.status === "completed" ? " complete" : ""}`} aria-label="Run phases">
          {GROUPS.map((g, i) => (
            <li key={g.label} className={stepState(i)} aria-current={i === groupIdx ? "step" : undefined}>
              {g.label}
            </li>
          ))}
        </ol>
        {run.status === "running" && run.totalSteps > 0 && (
          <div className="progress slim" role="progressbar" aria-label="Training progress" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
        )}
        {active && (phase === "queued" || phase === "waiting_for_compute") && life.queueMessage && <Banner tone="info">{life.queueMessage}</Banner>}
        {active && (phase === "queued" || phase === "waiting_for_compute") && (autoscaling || workersOnline !== null) && (
          <Banner tone="info">
            {autoscaling
              ? "Starting a worker: the pool scales from zero, so the first claim can take a few minutes."
              : workersOnline === 0
                ? "No worker of this kind is online. The run starts when one connects."
                : `${workersOnline} worker${workersOnline === 1 ? "" : "s"} of this kind online, all busy. The run starts when one frees up.`}
          </Banner>
        )}
        {life.lastInterruption && (
          <Banner tone="warn">
            <b>Attempt {life.lastInterruption.attempt} interrupted</b> ({REASON_LABEL[life.lastInterruption.reason] ?? life.lastInterruption.reason}) at step {int(life.lastInterruption.step)}
            {life.lastInterruption.resumeStep !== null ? `; resumed from step ${int(life.lastInterruption.resumeStep)}` : "; restarted from scratch"}
            <span className="muted"> · {ago(life.lastInterruption.at, now)}</span>
          </Banner>
        )}
      </div>
    </section>
  );
};

// ------------------------------------------------------------ stats + charts

const last = <T,>(xs: (T | null)[]): T | null => {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== null && xs[i] !== undefined) return xs[i] as T;
  return null;
};

const RunStats = ({ run, stream }: { run: Run; stream: RunStreamState }) => {
  const m = run.latestMetric;
  const loss = last(stream.series.loss) ?? m?.loss ?? null;
  const evalLoss = last(stream.series.evalLoss) ?? (m ? evalLossOf(m) : null);
  const tps = last(stream.series.tokensPerSec) ?? m?.tokensPerSec ?? null;
  const lr = last(stream.series.lr) ?? m?.lr ?? null;
  return (
    <div className="stats">
      <Stat label="Train loss" value={num(loss)} />
      <Stat label="Eval loss" value={num(evalLoss)} />
      <Stat label="Learning rate" value={num(lr, 3)} hint={run.resolvedConfig.schedule} />
      <Stat label="Tokens / s" value={compact(tps)} />
      <Stat label="Tokens" value={compact(run.tokensProcessed)} hint={`${usd(run.pricePerMillionTokens)} / M`} />
      <div className="stat">
        <div className="stat-label">Cost</div>
        <div className="stat-value">
          {usd(run.costUsd)}
          <span className="of"> {run.maxCostUsd !== null ? `of ${usd(run.maxCostUsd)} cap` : "no cap"}</span>
        </div>
        <Meter label="Cost against the cap" value={run.costUsd} max={run.maxCostUsd} />
      </div>
    </div>
  );
};

/** Whether the cost cap is worth drawing: far above the spend, it flattens the cost line to zero. */
const showCap = (spent: number, cap: number | null): cap is number => cap !== null && cap > 0 && spent >= cap * 0.2;

const Charts = ({ run, stream }: { run: Run; stream: RunStreamState }) => {
  const s = stream.series;
  const hasEval = s.evalLoss.some((v) => v !== null);
  const drawCap = showCap(run.costUsd, run.maxCostUsd);
  const cap = useMemo(() => (drawCap ? s.step.map(() => run.maxCostUsd) : null), [drawCap, run.maxCostUsd, s.step]);
  const loss = useMemo(() => smooth(s.loss), [s.loss]);
  const tps = useMemo(() => smooth(s.tokensPerSec), [s.tokensPerSec]);
  const waiting = "No data yet";
  return (
    <div className="chart-grid">
      <ChartCard title="Loss" value={num(last(s.loss))} legend={[{ label: "train", color: "--chart-1" }, ...(hasEval ? [{ label: "eval", color: "--chart-2" as const, dashed: true }] : [])]}>
        <LineChart
          x={s.step}
          format={(v) => num(v, 3)}
          empty={waiting}
          series={[
            { label: "raw", values: s.loss, color: "--chart-1", faint: true },
            { label: "train", values: loss, color: "--chart-1" },
            ...(hasEval ? [{ label: "eval", values: s.evalLoss, color: "--chart-2" as const, dashed: true, sparse: true }] : []),
          ]}
        />
      </ChartCard>
      <ChartCard title="Learning rate" value={num(last(s.lr), 3)} legend={[{ label: run.resolvedConfig.schedule, color: "--chart-4" }]}>
        <LineChart x={s.step} format={(v) => num(v, 3)} empty={waiting} series={[{ label: "lr", values: s.lr, color: "--chart-4" }]} />
      </ChartCard>
      <ChartCard title="Throughput" value={`${compact(last(s.tokensPerSec))} tok/s`}>
        <LineChart
          x={s.step}
          format={compact}
          empty={waiting}
          series={[
            { label: "raw", values: s.tokensPerSec, color: "--chart-3", faint: true },
            { label: "tok/s", values: tps, color: "--chart-3" },
          ]}
        />
      </ChartCard>
      <ChartCard
        title="Cost"
        value={`${usd(run.costUsd)}${run.maxCostUsd !== null ? ` / ${usd(run.maxCostUsd)}` : ""}`}
        legend={cap ? [{ label: "spent", color: "--chart-1" }, { label: "cap", color: "--red", dashed: true }] : run.maxCostUsd !== null ? [{ label: `${Math.round((run.costUsd / run.maxCostUsd) * 100)}% of cap`, color: "--chart-1" }] : undefined}
      >
        <LineChart x={s.step} format={usd} empty={waiting} series={[{ label: "spent", values: s.costUsd, color: "--chart-1" }, ...(cap ? [{ label: "cap", values: cap, color: "--red" as const, dashed: true }] : [])]} />
      </ChartCard>
    </div>
  );
};

const ChartCard = ({ title, value, legend, children }: { title: string; value: string; legend?: { label: string; color: ChartColor; dashed?: boolean }[] | undefined; children: ReactNode }) => (
  <section className="card chart-card">
    <header className="card-header">
      <h2 className="card-title">
        {title}
        <span className="chart-value">
          <b>{value}</b>
        </span>
      </h2>
      {legend && (
        <div className="chart-legend">
          {legend.map((l) => (
            <span key={l.label} className="key">
              <span className={`swatch${l.dashed ? " dashed" : ""}`} style={{ borderColor: `var(${l.color})` }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </header>
    {children}
  </section>
);

// ------------------------------------------------------------ checkpoints

const Checkpoints = ({ run, checkpointEvents, onPromoted }: { run: Run; checkpointEvents: number; onPromoted: () => void }) => {
  const { client } = useApi();
  const toast = useToast();
  const res = useResource((signal) => client.listRunCheckpoints(run.id, { limit: 100 }, { signal }), [run.id, checkpointEvents, run.status], {
    pollMs: isTerminalRun(run) ? undefined : 15_000,
  });
  const [promote, setPromote] = useState<Checkpoint | null>(null);
  const [name, setName] = useState("");
  const rows = [...(res.data?.data ?? [])].sort((a, b) => b.step - a.step);
  return (
    <Card title="Checkpoints" count={rows.length || undefined} tight>
      <ErrorBanner error={res.error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Attempt</th>
              <th className="right">Eval score</th>
              <th>Format</th>
              <th className="right">Size</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {res.loading && !res.data && <SkeletonRows rows={2} cols={7} />}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="num">
                  <span className="actions">
                    {int(c.step)}
                    {c.best && <Badge tone="green">best</Badge>}
                    {c.final && <Badge>final</Badge>}
                  </span>
                </td>
                <td className="num muted">{c.attempt}</td>
                <td className="right num">{num(c.evalScore)}</td>
                <td className="muted">{c.format ?? "—"}</td>
                <td className="right num muted">{bytes(c.sizeBytes)}</td>
                <td className="muted">{c.expiresAt ? ago(c.expiresAt) : "never"}</td>
                <td className="right">
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setName(run.name);
                      setPromote(c);
                    }}
                  >
                    Promote
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {res.data && rows.length === 0 && <Empty title="No checkpoints yet">{isTerminalRun(run) ? "This run saved no checkpoints." : `Checkpoints appear every ${int(run.resolvedConfig.checkpointEverySteps)} steps.`}</Empty>}
      {promote && (
        <Confirm
          title={`Promote step ${promote.step}?`}
          confirm="Promote"
          body={
            <div className="form">
              <p>Creates an immutable artifact from this checkpoint. It no longer expires.</p>
              <label className="field">
                Artifact name
                <input id="promote-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
          }
          onConfirm={async () => {
            const art = await client.promoteCheckpoint(promote.id, name.trim() ? { name: name.trim() } : {});
            toast(`Promoted to ${art.name}@${art.version}`);
            res.reload();
            onPromoted();
          }}
          onClose={() => setPromote(null)}
        />
      )}
    </Card>
  );
};

// ------------------------------------------------------------ report, artifact, config

const EvalReportCard = ({ run }: { run: Run }) => {
  const report = run.evalReport;
  if (!report) return null;
  const r = renderReport(run.recipeKind, report);
  return (
    <Card title="Eval report" actions={<span className="chip">{run.recipeKind}</span>}>
      <div className="stack">
        {r.warnings.map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}
        {r.headline.length > 0 && (
          <div className="stats flat">
            {r.headline.map((row) => (
              <Stat key={row.label} label={row.label} value={row.value} hint={row.hint} />
            ))}
          </div>
        )}
        {r.pareto.length > 0 && (
          <div>
            <div className="section-label">Routing trade-off</div>
            <dl className="kv">
              {r.pareto.map((row) => (
                <Kv key={row.label} label={row.label} value={row.value} />
              ))}
            </dl>
          </div>
        )}
        {r.heads.length > 0 && (
          <table className="table flat">
            <thead>
              <tr>
                <th>Head</th>
                <th className="right">Accuracy</th>
                <th className="right">Macro F1</th>
              </tr>
            </thead>
            <tbody>
              {r.heads.map((h) => (
                <tr key={h.name}>
                  <td className="mono">{h.name}</td>
                  <td className="right">{num(h.accuracy)}</td>
                  <td className="right">{num(h.macroF1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="kv">
          {r.details.map((row) => (
            <Kv key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
      </div>
    </Card>
  );
};

const Kv = ({ label, value }: { label: string; value: ReactNode }) => (
  <>
    <dt>{label}</dt>
    <dd>{value}</dd>
  </>
);

const LARGE_DOWNLOAD = 2 * 1024 ** 3;

const ArtifactCard = ({ id }: { id: string }) => {
  const { client } = useApi();
  const res = useResource((signal) => client.getArtifact(id, { signal }), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const a = res.data;
  const download = async (art: Artifact) => {
    setBusy(true);
    setError(null);
    try {
      const raw = await client.downloadArtifact(art.id);
      const blob = await new Response(raw.body).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${art.name}-${art.version}.grad.tar.gz`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Artifact"
      actions={
        a && (
          <button type="button" className="btn sm" onClick={() => void download(a)} disabled={busy} title={a.sizeBytes > LARGE_DOWNLOAD ? "Large artifact: the CLI download is faster and verifies the checksum" : undefined}>
            {busy ? <span className="spinner" /> : <IconDownload />}
            Download {bytes(a.sizeBytes)}
          </button>
        )
      }
    >
      <ErrorBanner error={res.error ?? error} />
      {a ? (
        <div className="stack">
          <dl className="kv">
            <Kv label="Name" value={<span className="mono">{`${a.name}@${a.version}`}</span>} />
            <Kv label="Format" value={a.format ?? "—"} />
            <Kv label="Base model" value={<span className="mono">{a.baseModel}</span>} />
            <Kv label="SHA-256" value={<span className="mono faint">{a.sha256}</span>} />
            <Kv label="Created" value={dateTime(a.createdAt)} />
          </dl>
          <Command cmd={`grad artifacts download ${a.name}@${a.version} --output ./${a.name}`} />
        </div>
      ) : (
        !res.error && <div className="skeleton" />
      )}
    </Card>
  );
};

const ConfigCard = ({ run }: { run: Run }) => {
  const yaml = useMemo(() => toYaml(convertKeys(CODEC, "ResolvedRunConfig", run.resolvedConfig, "encode")), [run.resolvedConfig]);
  return (
    <details className="card disclosure">
      <summary className="card-header">
        <h2 className="card-title">
          <IconChevron className="chev" />
          Resolved config
        </h2>
        <span onClick={(e) => e.preventDefault()}>
          <CopyButton text={yaml} label="Copy YAML" />
        </span>
      </summary>
      <pre className="code">{yaml}</pre>
    </details>
  );
};

// ------------------------------------------------------------ timeline

const Timeline = ({ items }: { items: TimelineItem[] }) => {
  const list = useRef<HTMLOListElement>(null);
  const ordered = foldCheckpoints([...items].reverse());
  useEffect(() => {
    list.current?.scrollTo?.({ top: 0 });
  }, [items.length]);
  return (
    <Card title="Events" count={items.length || undefined} tight>
      {ordered.length === 0 ? (
        <Empty title="No events yet">Phases, attempts, checkpoints and warnings appear here as they happen.</Empty>
      ) : (
        <ol className="timeline" ref={list}>
          {ordered.map((t) => (
            <li key={t.key} className={t.kind}>
              <span className="mark" />
              <div>
                <div className="t-title">{t.title}</div>
                {t.detail && <div className="t-detail">{t.detail}</div>}
              </div>
              <span className="t-time" title={dateTime(t.timestamp)}>
                {time(t.timestamp)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
};

// ------------------------------------------------------------ resume

const ResumeDialog = ({ run, onDone, onClose }: { run: Run; onDone: () => void; onClose: () => void }) => {
  const { client } = useApi();
  const [cap, setCap] = useState(run.status === "stopped_budget" && run.maxCostUsd !== null ? String(Math.ceil(run.maxCostUsd * 2)) : "");
  return (
    <Confirm
      title="Resume this run?"
      confirm="Resume"
      body={
        <div className="form">
          <p>Continues from the latest checkpoint as a new attempt.</p>
          <label className="field">
            Cost cap (USD){run.maxCostUsd !== null ? `, currently ${usd(run.maxCostUsd)}` : ""}
            <input id="resume-cap" className="input" inputMode="decimal" placeholder="keep current" value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
        </div>
      }
      onConfirm={async () => {
        const value = Number(cap);
        await client.resumeRun(run.id, cap.trim() && Number.isFinite(value) ? { maxCostUsd: value } : {});
        onDone();
      }}
      onClose={onClose}
    />
  );
};
