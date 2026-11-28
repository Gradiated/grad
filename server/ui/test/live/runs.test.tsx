import { afterAll, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app.js";
import { navigate } from "../../src/lib/router.js";
import { byText, click, confirmHandoff, mount, waitFor, type Mounted } from "../helpers.js";

vi.mock("uplot", () => ({ default: class { setData() {} setSize() {} destroy() {} } }));

const base = process.env.GRAD_LIVE_BASE_URL ?? "http://127.0.0.1:18787";
const key = process.env.GRAD_LIVE_API_KEY;

describe("web UI against a live grad-server", () => {
  let app: Mounted | undefined;
  afterAll(() => app?.unmount());

  it("serves the UI shell at /runs with its CSP", async () => {
    const res = await fetch(`${base}/runs`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("signs in from a #key= handoff, lists the runs and opens one", async () => {
    const runs = (await (await fetch(`${base}/v1/runs?limit=5`, { headers: key ? { authorization: `Bearer ${key}` } : {} })).json()) as { data: { id: string; name: string }[] };
    history.replaceState(null, "", key ? `/runs#key=${encodeURIComponent(key)}` : "/runs");
    app = await mount(<App baseURL={base} />);
    if (key) await confirmHandoff(app.container);
    await waitFor(() => expect(app?.container.querySelector("h1")?.textContent).toBe("Runs"), 20_000);
    expect(location.hash).toBe("");
    const first = runs.data[0];
    if (!first) return;
    await waitFor(() => expect(app?.container.textContent).toContain(first.name), 20_000);
    await click(byText(app.container, "tbody tr", first.id));
    await waitFor(() => expect(app?.container.textContent).toContain("Checkpoints"), 20_000);
    await waitFor(() => expect(app?.container.querySelectorAll(".timeline li").length ?? 0).toBeGreaterThan(0), 20_000);
  });

  it("lists the artifacts and opens one", async () => {
    if (!app) return;
    const artifacts = (await (await fetch(`${base}/v1/artifacts?limit=1`, { headers: key ? { authorization: `Bearer ${key}` } : {} })).json()) as { data: { name: string; version: string }[] };
    navigate("/artifacts");
    await waitFor(() => expect(app?.container.querySelector("h1")?.textContent).toBe("Artifacts"), 20_000);
    const first = artifacts.data[0];
    if (!first) return;
    const ref = `${first.name}@${first.version}`;
    await waitFor(() => expect(byText(app!.container, "tbody tr", ref)).toBeTruthy(), 20_000);
    await click(byText(app.container, "tbody tr", ref));
    await waitFor(() => expect(app?.container.textContent).toContain("Provenance"), 20_000);
    expect(app.container.querySelector("pre.code")?.textContent).toContain("grad.artifact/1");
  });
});
