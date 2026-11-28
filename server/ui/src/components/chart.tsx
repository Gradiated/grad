import { useEffect, useRef, type ReactNode } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";

import { useTheme } from "../lib/theme.js";

/** A colour token from styles/tokens.css: the chart palette, or red for limits. */
export type ChartColor = "--chart-1" | "--chart-2" | "--chart-3" | "--chart-4" | "--chart-5" | "--red";

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  color: ChartColor;
  dashed?: boolean;
  /** Draw only points (sparse series such as eval loss), joined by a line. */
  sparse?: boolean;
  /** A raw series drawn faintly behind its smoothed copy; left out of the hover readout. */
  faint?: boolean;
}

export interface LineChartProps {
  x: number[];
  /** Changes whenever `x` or a series grew in place (Series.rev); without it, array identity decides. */
  rev?: number;
  series: ChartSeries[];
  format: (v: number) => string;
  xLabel?: string;
  height?: number;
  empty?: string;
  /** The readout shows each series' nearest point when it has none at the hovered step (runs logged at different steps). */
  nearest?: boolean;
}

/** Exponential moving average (TensorBoard-style smoothing); nulls pass through. */
export const smooth = (values: (number | null)[], weight = 0.9): (number | null)[] => {
  let acc = 0;
  let n = 0;
  return values.map((v) => {
    if (v === null) return null;
    n++;
    acc = acc * weight + v * (1 - weight);
    // Debiased, so the first points don't lean towards zero.
    return acc / (1 - weight ** n);
  });
};

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

const withAlpha = (color: string, alpha: number) => `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;

/** The value of the closer of a series' neighbours around `idx`; none outside the series' own range. */
export const nearestAt = (col: ArrayLike<number | null | undefined>, idx: number): number | null => {
  let l = idx - 1;
  while (l >= 0 && (col[l] === null || col[l] === undefined)) l--;
  let r = idx + 1;
  while (r < col.length && (col[r] === null || col[r] === undefined)) r++;
  if (l < 0 || r >= col.length) return null;
  return (idx - l <= r - idx ? col[l] : col[r]) ?? null;
};

const readout = (el: HTMLElement | null, u: uPlot, props: LineChartProps) => {
  if (!el) return;
  const idx = u.cursor.idx;
  if (idx === null || idx === undefined) {
    el.replaceChildren();
    return;
  }
  const parts: Node[] = [];
  const add = (label: string, value: string) => {
    const span = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = value;
    span.append(`${label} `, b);
    parts.push(span);
  };
  add(props.xLabel ?? "step", (u.data[0][idx] ?? 0).toLocaleString("en-US"));
  props.series.forEach((s, i) => {
    const col = u.data[i + 1];
    let v = col?.[idx];
    if (props.nearest && col && (v === null || v === undefined)) v = nearestAt(col, idx);
    if (!s.faint && v !== null && v !== undefined) add(s.label, props.format(v));
  });
  el.replaceChildren(...parts);
};

const buildOptions = (width: number, height: number, props: LineChartProps, readoutEl: () => HTMLElement | null): Options => {
  const grid = cssVar("--grid");
  const axis = cssVar("--faint");
  const font = `11px ${cssVar("--font")}`;
  const axisCommon = { stroke: axis, font, grid: { stroke: grid, width: 1 }, ticks: { show: false }, gap: 6 };
  return {
    width,
    height,
    // Right padding keeps the last x label ("100,000") inside the card.
    padding: [12, 24, 0, 0],
    legend: { show: false },
    cursor: { y: false, points: { size: 7, width: 2 }, drag: { x: true, y: false } },
    scales: { x: { time: false } },
    hooks: { setCursor: [(u) => readout(readoutEl(), u, props)] },
    axes: [
      { ...axisCommon, size: 28, values: (_u, ticks) => ticks.map((t) => (Number.isInteger(t) ? t.toLocaleString("en-US") : "")) },
      { ...axisCommon, size: 60, values: (_u, ticks) => ticks.map((t) => props.format(t)) },
    ],
    series: [
      { label: props.xLabel ?? "step" },
      ...props.series.map((s) => {
        const color = cssVar(s.color);
        return {
          label: s.label,
          stroke: s.faint ? withAlpha(color, 0.28) : color,
          width: s.faint ? 1 : 1.75,
          spanGaps: true,
          ...(s.dashed ? { dash: [5, 4] } : {}),
          points: s.sparse ? { show: true, size: 6, width: 1.75, fill: cssVar("--panel") } : { show: false },
        };
      }),
    ],
  };
};

/** A themed uPlot line chart that resizes with its container, updates in place and reads out the hovered step. */
export const LineChart = (props: LineChartProps) => {
  const host = useRef<HTMLDivElement>(null);
  const out = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const theme = useTheme();
  const height = props.height ?? 200;
  const data: AlignedData = [props.x, ...props.series.map((s) => s.values)] as AlignedData;
  const hasData = props.x.length > 0 && props.series.some((s) => s.values.some((v) => v !== null));
  const shape = props.series.map((s) => `${s.label}:${s.color}:${s.dashed ? 1 : 0}`).join("|");

  // (Re)create on theme or series-shape change; data updates go through setData.
  useEffect(() => {
    const el = host.current;
    if (!el || !hasData) return;
    let chart: uPlot;
    try {
      chart = new uPlot(
        buildOptions(Math.max(200, el.clientWidth), height, props, () => out.current),
        data,
        el,
      );
    } catch {
      return; // no canvas (tests, ancient browsers)
    }
    plot.current = chart;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => chart.setSize({ width: Math.max(200, el.clientWidth), height })) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      chart.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, shape, height, hasData]);

  // Redraw only when a series array changed, not on every parent render (a clock tick).
  const drawn = useRef<{ data: AlignedData; rev: number | undefined } | null>(null);
  useEffect(() => {
    const prev = drawn.current;
    if (prev && plot.current && prev.rev === props.rev && prev.data.length === data.length && prev.data.every((a, i) => a === data[i])) return;
    drawn.current = { data, rev: props.rev };
    plot.current?.setData(data);
  });

  return (
    <div className="chart" style={{ height: height + 10 }}>
      <div className="chart-readout" ref={out} aria-hidden="true" />
      <div ref={host} />
      {!hasData && <div className="chart-empty">{props.empty ?? "No data yet"}</div>}
    </div>
  );
};

export interface LegendKey {
  label: string;
  color: ChartColor;
  dashed?: boolean;
}

/** A chart in a card: its title, the current value and a legend. */
export const ChartCard = ({ title, value, legend, children }: { title: string; value?: string; legend?: LegendKey[] | undefined; children: ReactNode }) => (
  <section className="card chart-card">
    <header className="card-header">
      <h2 className="card-title">
        {title}
        {value !== undefined && (
          <span className="chart-value">
            <b>{value}</b>
          </span>
        )}
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
