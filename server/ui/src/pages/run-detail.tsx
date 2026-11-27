import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Artifact, Checkpoint, Run } from "@sdk/generated/models.js";

import { LineChart } from "../components/chart.js";
import { IconChevron, IconDownload, IconPlay, IconStop } from "../components/icons.js";
import { Banner, Card, Command, Confirm, CopyButton, Empty, ErrorBanner, Meter, SkeletonRows, Stat, StatusBadge, useToast } from "../components/ui.js";
import { CODEC, convertKeys, errorMessage, isTerminalRun, lifecycleOf, useApi, type RunLifecycle, type RunPhase } from "../lib/api.js";
import { evalLossOf, PHASE_LABEL, REASON_LABEL, type RunStreamState, type TimelineItem } from "../lib/events.js";
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
        {polled.error ? <ErrorBanner error={polled.error} /> : <div className="skeleton" style={{ height: 28, width: 260 }} />}
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
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">
            {run.name}
            <StatusBadge status={run.status} />
          </h1>
          <div className="page-sub">
            <span className="mono">{run.id}</span>
            <CopyButton text={run.id} label="Copy run id" />
            <span className="sep" />
            <span className="chip">{run.recipeKind}</span>
            <span className="mono">{run.resolvedConfig.model}</span>
            <span className="sep" />
            <Link className="link" href={`/datasets/${encodeURIComponent(run.datasetName)}`}>
              {run.datasetName}
            </Link>
            <span className="faint">v{run.datasetVersion}</span>
            <span className="sep" />
            <span title={dateTime(run.createdAt)}>created {ago(run.createdAt, now)}</span>
            <span className="sep" />
            <span>{active ? "running for" : "took"} {duration(ended - started)}</span>
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
      <Charts run={run} stream={stream} />

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

  return (
    <section className="card">
      <div className="card-body" style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{phase ? PHASE_LABEL[phase] : run.status === "completed" ? "Completed" : failed ? `Ended ${run.status === "failed" ? "with an error" : run.status === "cancelled" ? "by cancellation" : "at the cost cap"}` : "—"}</span>
            {phase && since && <span className="muted">for {duration(now - Date.parse(since))}</span>}
            {stream.gpu && <span className="chip">{stream.gpu.name} · {stream.gpu.memoryGb} GB</span>}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "baseline" }} className="num">
            <span>
              <span className="muted">Step </span>
              {int(run.currentStep)}
              <span className="faint"> / {int(run.totalSteps)}</span>
            </span>
            <span title="Attempts started; attempts whose compute was reclaimed don't count toward the failure cap.">
              <span className="muted">Attempt </span>
              {Math.max(run.attempt, 1)}
              <span className="faint"> / {run.maxAttempts}</span>
            </span>
          </div>
        </div>
        <div>
          <div className={`phase-strip${failed ? " failed" : ""}`}>
            {GROUPS.map((g, i) => (
              <div key={g.label} className={`seg${i < groupIdx || run.status === "completed" ? " done" : i === groupIdx ? " now" : ""}`} />
            ))}
          </div>
          <div className="phase-labels">
            {GROUPS.map((g) => (
              <span key={g.label}>{g.label}</span>
            ))}
          </div>
        </div>
        {run.status === "running" && run.totalSteps > 0 && (
          <div className="progress slim" aria-label="Training progress">
            <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
        )}
        {active && (phase === "queued" || phase === "waiting_for_compute") && (autoscaling || workersOnline !== null) && (
          <Banner tone="info">
            {autoscaling
              ? "Starting a worker: the pool scales from zero, so the first claim can take a few minutes."
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
      <div className="stat" style={{ minWidth: 200 }}>
        <Meter
          label="Cost"
          value={run.costUsd}
          max={run.maxCostUsd}
          right={
            <>
              <b>{usd(run.costUsd)}</b>
              <span className="faint"> {run.maxCostUsd !== null ? `of ${usd(run.maxCostUsd)} cap` : "no cap"}</span>
            </>
          }
        />
      </div>
    </div>
  );
};

const Charts = ({ run, stream }: { run: Run; stream: RunStreamState }) => {
  const s = stream.series;
  const hasEval = s.evalLoss.some((v) => v !== null);
  const cap = useMemo(() => (run.maxCostUsd === null ? null : s.step.map(() => run.maxCostUsd)), [run.maxCostUsd, s.step]);
  const waiting = isTerminalRun(run) ? "No metrics were recorded" : "Waiting for the first step";
  return (
    <div className="chart-grid">
      <ChartCard title="Loss" value={num(last(s.loss))} legend={[{ label: "train", tone: "accent" }, ...(hasEval ? [{ label: "eval", tone: "amber", dashed: true }] : [])]}>
        <LineChart
          x={s.step}
          format={(v) => num(v, 3)}
          empty={waiting}
          series={[{ label: "train", values: s.loss, tone: "accent" }, ...(hasEval ? [{ label: "eval", values: s.evalLoss, tone: "amber" as const, dashed: true, sparse: true }] : [])]}
        />
      </ChartCard>
      <ChartCard title="Learning rate" value={num(last(s.lr), 3)}>
        <LineChart x={s.step} format={(v) => num(v, 2)} empty={waiting} series={[{ label: "lr", values: s.lr, tone: "blue" }]} />
      </ChartCard>
      <ChartCard title="Throughput" value={`${compact(last(s.tokensPerSec))} tok/s`}>
        <LineChart x={s.step} format={compact} empty={waiting} series={[{ label: "tokens/s", values: s.tokensPerSec, tone: "green" }]} />
      </ChartCard>
      <ChartCard title="Cost" value={`${usd(run.costUsd)}${run.maxCostUsd !== null ? ` / ${usd(run.maxCostUsd)}` : ""}`} legend={cap ? [{ label: "spent", tone: "accent" }, { label: "cap", tone: "red", dashed: true }] : undefined}>
        <LineChart
          x={s.step}
          format={usd}
          empty={waiting}
          series={[{ label: "cost", values: s.costUsd, tone: "accent" }, ...(cap ? [{ label: "cap", values: cap, tone: "red" as const, dashed: true }] : [])]}
        />
      </ChartCard>
    </div>
  );
};

const ChartCard = ({ title, value, legend, children }: { title: string; value: string; legend?: { label: string; tone: string; dashed?: boolean }[] | undefined; children: ReactNode }) => (
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
              <span className={`swatch${l.dashed ? " dashed" : ""}`} style={{ background: `var(--${l.tone})`, borderColor: `var(--${l.tone})` }} />
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
                  {int(c.step)} {c.best && <span className="badge green">best</span>} {c.final && <span className="badge outline">final</span>}
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
      {res.data && rows.length === 0 && <Empty title="No checkpoints yet">Checkpoints appear every {int(run.resolvedConfig.checkpointEverySteps)} steps.</Empty>}
      {promote && (
        <Confirm
          title={`Promote step ${promote.step}?`}
          confirm="Promote"
          body={
            <div style={{ display: "grid", gap: 8 }}>
              <p>Creates an immutable artifact from this checkpoint. It no longer expires.</p>
              <label className="muted" htmlFor="promote-name" style={{ fontSize: 12 }}>
                Artifact name
              </label>
              <input id="promote-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
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
      <div style={{ display: "grid", gap: 16 }}>
        {r.warnings.map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}
        {r.headline.length > 0 && (
          <div className="stats" style={{ boxShadow: "none" }}>
            {r.headline.map((row) => (
              <Stat key={row.label} label={row.label} value={row.value} hint={row.hint} />
            ))}
          </div>
        )}
        {r.pareto.length > 0 && (
          <div>
            <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
              Routing trade-off
            </div>
            <dl className="kv">
              {r.pareto.map((row) => (
                <Kv key={row.label} label={row.label} value={row.value} />
              ))}
            </dl>
          </div>
        )}
        {r.heads.length > 0 && (
          <table className="table">
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
        <div style={{ display: "grid", gap: 14 }}>
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
        !res.error && <div className="skeleton" style={{ width: "60%" }} />
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
  const ordered = [...items].reverse();
  useEffect(() => {
    list.current?.scrollTo?.({ top: 0 });
  }, [items.length]);
  return (
    <Card title="Events" count={items.length || undefined} tight>
      {ordered.length === 0 ? (
        <Empty title="No events yet" />
      ) : (
        <ol className="timeline" ref={list}>
          {ordered.map((t) => (
            <li key={t.key} className={t.kind}>
              <span className="mark" />
              <div style={{ minWidth: 0 }}>
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
        <div style={{ display: "grid", gap: 8 }}>
          <p>Continues from the latest checkpoint as a new attempt.</p>
          <label className="muted" htmlFor="resume-cap" style={{ fontSize: 12 }}>
            Cost cap (USD){run.maxCostUsd !== null ? `, currently ${usd(run.maxCostUsd)}` : ""}
          </label>
          <input id="resume-cap" className="input" inputMode="decimal" placeholder="keep current" value={cap} onChange={(e) => setCap(e.target.value)} />
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
