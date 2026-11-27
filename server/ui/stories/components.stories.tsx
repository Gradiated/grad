import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";

import { LineChart, smooth } from "../src/components/chart.js";
import { IconDownload, IconPlay, IconStop } from "../src/components/icons.js";
import { Badge, Banner, Card, Command, Empty, Meter, Segmented, SkeletonRows, Stat, StatusBadge, ToastProvider } from "../src/components/ui.js";

const Frame = ({ children }: { children: ReactNode }) => (
  <ToastProvider>
    <div className="main">
      <div className="page">{children}</div>
    </div>
  </ToastProvider>
);

const meta = { title: "Components", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const STATUSES = ["queued", "running", "awaiting_scores", "completed", "failed", "cancelled", "stopped_budget"];

export const Badges: Story = {
  render: () => (
    <Frame>
      <div className="actions">
        {STATUSES.map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </div>
      <div className="actions">
        <Badge tone="green">ready</Badge>
        <Badge tone="accent">scaling up</Badge>
        <Badge tone="red">no workers</Badge>
        <Badge>final</Badge>
        <span className="chip">sft</span>
        <span className="chip mono">qwen/qwen3-8b</span>
        <span className="chip">
          resolved <b>1</b>
        </span>
        <span className="led">live</span>
        <span className="led off">offline</span>
      </div>
    </Frame>
  ),
};

export const Buttons: Story = {
  render: () => (
    <Frame>
      <div className="actions">
        <button type="button" className="btn primary">
          Promote
        </button>
        <button type="button" className="btn">
          <IconPlay /> Resume
        </button>
        <button type="button" className="btn danger">
          <IconStop /> Cancel
        </button>
        <button type="button" className="btn danger solid">
          Cancel run
        </button>
        <button type="button" className="btn ghost">
          Ghost
        </button>
        <button type="button" className="btn sm">
          <IconDownload /> Download 84 MB
        </button>
        <button type="button" className="btn" disabled>
          <span className="spinner" /> Working
        </button>
      </div>
      <SegmentedDemo />
      <div className="toolbar">
        <input className="input" placeholder="Filter by name" aria-label="Filter" />
        <select className="input" aria-label="Version">
          <option>v4 (latest)</option>
        </select>
        <input className="input" type="date" aria-label="From" defaultValue="2026-11-01" />
      </div>
    </Frame>
  ),
};

const SegmentedDemo = () => {
  const [v, setV] = useState<"all" | "active" | "failed">("all");
  return (
    <Segmented
      label="Status"
      value={v}
      onChange={setV}
      options={[
        { value: "all", label: "All", count: 7 },
        { value: "active", label: "Active", count: 2 },
        { value: "failed", label: "Failed", count: 1 },
      ]}
    />
  );
};

export const Feedback: Story = {
  render: () => (
    <Frame>
      <Banner tone="info">Waiting for a GPU with ≥46 GB; online workers have 24 GB.</Banner>
      <Banner tone="warn">
        <b>Attempt 1 interrupted</b> (compute reclaimed) at step 212; resumed from step 200
      </Banner>
      <Banner
        action={
          <button type="button" className="btn sm">
            Retry
          </button>
        }
      >
        Cannot reach grad-server: Failed to fetch
      </Banner>
      <Card title="Empty state">
        <Empty title="No runs yet">
          Start one with <code>grad train</code> or <code>client.runs.create(...)</code>.
        </Empty>
      </Card>
      <Card title="Loading" tight>
        <table className="table">
          <tbody>
            <SkeletonRows rows={3} cols={4} />
          </tbody>
        </table>
      </Card>
      <Command cmd="grad artifacts download support-sft@2026-11-27-1 --output ./support-sft" />
    </Frame>
  ),
};

export const Stats: Story = {
  render: () => (
    <Frame>
      <div className="stats">
        <Stat label="Train loss" value="0.4384" />
        <Stat label="Learning rate" value="6.4e-5" hint="cosine" />
        <Stat label="Tokens" value="80.3K" hint="$1.20 / M" />
        <div className="stat">
          <div className="stat-label">Cost</div>
          <div className="stat-value">
            $8.80<span className="of"> of $10.00 cap</span>
          </div>
          <Meter label="Cost against the cap" value={8.8} max={10} />
        </div>
      </div>
    </Frame>
  ),
};

const steps = Array.from({ length: 300 }, (_, i) => i + 1);
const raw = steps.map((s) => 0.42 + 1.9 * Math.exp(-s / 90) + Math.sin(s * 1.7) * 0.04);

export const Chart: Story = {
  render: () => (
    <Frame>
      <section className="card chart-card">
        <header className="card-header">
          <h2 className="card-title">
            Loss{" "}
            <span className="chart-value">
              <b>0.4421</b>
            </span>
          </h2>
        </header>
        <LineChart
          x={steps}
          format={(v) => v.toFixed(3)}
          series={[
            { label: "raw", values: raw, color: "--chart-1", faint: true },
            { label: "train", values: smooth(raw), color: "--chart-1" },
            { label: "eval", values: steps.map((s) => (s % 25 === 0 ? 0.47 + 1.7 * Math.exp(-s / 100) : null)), color: "--chart-2", dashed: true, sparse: true },
          ]}
        />
      </section>
      <section className="card chart-card">
        <header className="card-header">
          <h2 className="card-title">Empty</h2>
        </header>
        <LineChart x={[]} format={String} series={[{ label: "lr", values: [], color: "--chart-4" }]} empty="Waiting for the first step" />
      </section>
    </Frame>
  ),
};
