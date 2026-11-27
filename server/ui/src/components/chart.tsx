import { useEffect, useRef } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";

import { useColorScheme } from "../lib/hooks.js";

export type Tone = "accent" | "green" | "amber" | "blue" | "red";

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  tone: Tone;
  dashed?: boolean;
  /** Draw only points (sparse series such as eval loss), joined by a line. */
  sparse?: boolean;
}

export interface LineChartProps {
  x: number[];
  series: ChartSeries[];
  format: (v: number) => string;
  xLabel?: string;
  height?: number;
  empty?: string;
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

const buildOptions = (width: number, height: number, props: LineChartProps): Options => {
  const grid = cssVar("--border");
  const axis = cssVar("--faint");
  const font = `11px ${cssVar("--font")}`;
  const axisCommon = { stroke: axis, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 } };
  return {
    width,
    height,
    padding: [10, 8, 0, 0],
    legend: { show: false },
    cursor: { y: false, points: { size: 6 }, drag: { x: true, y: false } },
    scales: { x: { time: false } },
    axes: [
      { ...axisCommon, values: (_u, ticks) => ticks.map((t) => (Number.isInteger(t) ? t.toLocaleString("en-US") : "")) },
      { ...axisCommon, size: 56, values: (_u, ticks) => ticks.map((t) => props.format(t)) },
    ],
    series: [
      { label: props.xLabel ?? "step" },
      ...props.series.map((s) => ({
        label: s.label,
        stroke: cssVar(`--${s.tone}`),
        width: 1.6,
        spanGaps: true,
        ...(s.dashed ? { dash: [5, 4] } : {}),
        points: s.sparse ? { show: true, size: 5, width: 1.5, fill: cssVar("--panel") } : { show: false },
        value: (_u: uPlot, v: number | null) => (v === null ? "—" : props.format(v)),
      })),
    ],
  };
};

/** A themed uPlot line chart that resizes with its container and updates in place. */
export const LineChart = (props: LineChartProps) => {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const scheme = useColorScheme();
  const height = props.height ?? 210;
  const data: AlignedData = [props.x, ...props.series.map((s) => s.values)] as AlignedData;
  const hasData = props.x.length > 0 && props.series.some((s) => s.values.some((v) => v !== null));
  const shape = props.series.map((s) => `${s.label}:${s.tone}:${s.dashed ? 1 : 0}`).join("|");

  // (Re)create on theme or series-shape change; data updates go through setData.
  useEffect(() => {
    const el = host.current;
    if (!el || !hasData) return;
    let chart: uPlot;
    try {
      chart = new uPlot(buildOptions(Math.max(200, el.clientWidth), height, props), data, el);
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
  }, [scheme, shape, height, hasData]);

  useEffect(() => {
    plot.current?.setData(data);
  });

  return (
    <div className="chart" style={{ height: height + 12 }}>
      <div ref={host} />
      {!hasData && <div className="chart-empty">{props.empty ?? "No data yet"}</div>}
    </div>
  );
};
