import type { Meta, StoryObj } from "@storybook/react-vite";

import { Console } from "./console.js";
import { ARTIFACTS, json, never, problem, RUNS, workspace } from "./fake.js";

const meta = {
  title: "Pages",
  component: Console,
  args: { path: "/runs", routes: workspace() },
} satisfies Meta<typeof Console>;

export default meta;
type Story = StoryObj<typeof meta>;

const idOf = (r: Record<string, unknown>) => String(r.id);

// ------------------------------------------------------------ runs

/** A busy workspace: every run state at once. */
export const RunsWide: Story = { name: "Runs / wide" };

export const RunsEmpty: Story = {
  name: "Runs / empty",
  args: { routes: workspace({ "GET /v1/runs": { data: [], next_cursor: null } }) },
};

export const RunsLoading: Story = {
  name: "Runs / loading",
  args: { routes: workspace({ "GET /v1/runs": (url) => (url.searchParams.get("limit") === "1" ? json({ data: [], next_cursor: null }) : never()) }) },
};

export const RunsError: Story = {
  name: "Runs / error",
  args: { routes: workspace({ "GET /v1/runs": (url) => (url.searchParams.get("limit") === "1" ? json({ data: [], next_cursor: null }) : problem(403, "forbidden", "This key may not list runs in workspace ws_demo.")) }) },
};

// ------------------------------------------------------------ run detail

export const RunFinished: Story = { name: "Run / finished", args: { path: `/runs/${idOf(RUNS.finished)}` } };
export const RunTraining: Story = { name: "Run / training", args: { path: `/runs/${idOf(RUNS.training)}` } };
export const RunWaitingForGpu: Story = { name: "Run / waiting for a GPU", args: { path: `/runs/${idOf(RUNS.waiting)}` } };
export const RunInterrupted: Story = { name: "Run / interrupted and resumed", args: { path: `/runs/${idOf(RUNS.interrupted)}` } };
export const RunFailed: Story = { name: "Run / failed", args: { path: `/runs/${idOf(RUNS.failed)}` } };
export const RunStoppedAtCap: Story = { name: "Run / stopped at cap", args: { path: `/runs/${idOf(RUNS.capped)}` } };
export const RunLoading: Story = {
  name: "Run / loading",
  args: { path: `/runs/${idOf(RUNS.finished)}`, routes: workspace({ [`GET /v1/runs/${idOf(RUNS.finished)}`]: () => never() }) },
};
export const RunNotFound: Story = {
  name: "Run / not found",
  args: { path: "/runs/run_missing", routes: workspace({ "GET /v1/runs/run_missing": () => problem(404, "run_not_found", "Run 'run_missing' not found.") }) },
};

// ------------------------------------------------------------ the rest

export const Datasets: Story = { args: { path: "/datasets" } };
export const DatasetsEmpty: Story = { name: "Datasets / empty", args: { path: "/datasets", routes: workspace({ "GET /v1/datasets": { data: [], next_cursor: null } }) } };
export const DatasetDetail: Story = { name: "Dataset / records, sources, imports", args: { path: "/datasets/support-prod" } };
export const Artifacts: Story = { args: { path: "/artifacts" } };
export const ArtifactsEmpty: Story = { name: "Artifacts / empty", args: { path: "/artifacts", routes: workspace({ "GET /v1/artifacts": { data: [], next_cursor: null } }) } };
export const ArtifactsLoading: Story = { name: "Artifacts / loading", args: { path: "/artifacts", routes: workspace({ "GET /v1/artifacts": () => never() }) } };
export const ArtifactsError: Story = {
  name: "Artifacts / error",
  args: { path: "/artifacts", routes: workspace({ "GET /v1/artifacts": () => problem(403, "forbidden", "This key may not read artifacts in workspace ws_demo.") }) },
};
const artifactPath = (i: number) => `/artifacts/${encodeURIComponent(String(ARTIFACTS[i]?.id))}`;
export const ArtifactPinned: Story = { name: "Artifact / pinned upload", args: { path: artifactPath(0) } };
export const ArtifactFromRun: Story = { name: "Artifact / trained by a run", args: { path: artifactPath(1) } };
export const ArtifactImported: Story = { name: "Artifact / imported from the Hub", args: { path: artifactPath(2) } };
/** Delete on a pinned artifact: the dialog shows the server's 409 naming the holders. */
export const ArtifactDeleteRefused: Story = {
  name: "Artifact / delete refused (pinned)",
  args: { path: artifactPath(0) },
  play: async ({ canvasElement }) => {
    const button = async (scope: string, label: string) => {
      for (let i = 0; i < 100; i++) {
        const found = [...canvasElement.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) => b.textContent?.trim() === label);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no ${label} button`);
    };
    (await button(".page-header", "Delete")).click();
    (await button(".dialog", "Delete")).click();
  },
};
export const ArtifactNotFound: Story = {
  name: "Artifact / not found",
  args: { path: "/artifacts/missing%401", routes: workspace({ "GET /v1/artifacts/:id": () => problem(404, "artifact_not_found", "Artifact 'missing@1' not found.") }) },
};
export const Evals: Story = { args: { path: "/evals" } };
export const EvalDetail: Story = { name: "Eval / summary and failures", args: { path: "/evals/eval_5a7c9e1b3d2f40688a6c4e20" } };
export const EvalRunning: Story = { name: "Eval / running", args: { path: "/evals/eval_8c0e2a4b6d1f39577e9b1d3f" } };
export const Usage: Story = { args: { path: "/usage" } };
export const UsageEmpty: Story = {
  name: "Usage / empty period",
  args: {
    path: "/usage?from=2026-01-01&to=2026-01-31",
    routes: workspace({
      "GET /v1/usage": { data: [], next_cursor: null },
      "GET /v1/usage/summary": { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", cost_usd: 0, tokens: 0, records: 0, by_kind: [], groups: [], top_runs: [], top_evals: [], group_by: "day" },
    }),
  },
};
export const Health: Story = { args: { path: "/health" } };
export const HealthNotReady: Story = {
  name: "Health / not ready",
  args: { path: "/health", routes: workspace({ "GET /health/ready": () => problem(503, "not_ready", "database unreachable: connect ECONNREFUSED 10.0.3.7:5432") }) },
};
export const Login: Story = {
  args: { path: "/runs", signedIn: false, routes: workspace({ "GET /v1/runs": () => problem(401, "unauthorized", "Missing API key.") }) },
};
export const NotFound: Story = { name: "Not found", args: { path: "/nope" } };
