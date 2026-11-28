import { afterAll, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app.js";
import { confirmHandoff, mount, waitFor, type Mounted } from "../helpers.js";

vi.mock("uplot", () => ({ default: class { setData() {} setSize() {} destroy() {} } }));

const base = process.env.GRAD_LIVE_BASE_URL ?? "http://127.0.0.1:18787";
const key = process.env.GRAD_LIVE_API_KEY;

interface WireEval {
  id: string;
  name: string;
  status: string;
  judge_models: string[];
  summary: { model: string }[];
}

describe("eval report against a live grad-server", () => {
  let app: Mounted | undefined;
  afterAll(() => app?.unmount());

  // GRAD_LIVE_EVAL_ID picks the eval (tests/compose/smoke.sh passes its judged one); else the newest completed.
  it("renders an eval's summary, judges and failures", async () => {
    const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    const wanted = process.env.GRAD_LIVE_EVAL_ID;
    const ev = wanted
      ? ((await (await fetch(`${base}/v1/evals/${wanted}`, { headers: auth })).json()) as WireEval)
      : ((await (await fetch(`${base}/v1/evals?limit=20`, { headers: auth })).json()) as { data: WireEval[] }).data.find((e) => e.status === "completed");
    if (!ev) return;
    expect(ev.status).toBe("completed");

    history.replaceState(null, "", key ? `/evals/${ev.id}#key=${encodeURIComponent(key)}` : `/evals/${ev.id}`);
    app = await mount(<App baseURL={base} />);
    if (key) await confirmHandoff(app.container);
    await waitFor(() => expect(app?.container.querySelector("h1")?.textContent).toContain(ev.name), 20_000);
    const text = () => app?.container.textContent ?? "";
    await waitFor(() => expect(text()).toContain("Summary"), 20_000);
    const rows = [...app.container.querySelectorAll("tbody tr td:first-child .mono")].map((cell) => cell.textContent);
    expect(rows.sort()).toEqual(ev.summary.map((s) => s.model).sort());
    for (const judge of ev.judge_models) expect(text()).toContain(judge);
    // The failing tasks (their records and judge), or the all-passed empty state.
    await waitFor(() => expect(text().includes("No failures") || app?.container.querySelector(".record") !== null).toBe(true), 20_000);
  });
});
