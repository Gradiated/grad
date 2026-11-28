import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

// The core journey through the console against a real grad-server and the
// reference trainer: a scoped key signs in, a dataset's records show, a run is
// followed live to its artifact, a checkpoint is promoted, an eval compares two
// models against a baseline, filters live in the URL, destructive actions ask
// first, and no page has a serious accessibility violation. Data goes in
// through the public API, as the CLI and SDKs would put it there.

test.describe.configure({ mode: "serial" });

const base = () => process.env.GRAD_E2E_BASE_URL as string;
const admin = () => process.env.GRAD_E2E_API_KEY as string;
const suffix = Date.now().toString(36);
const DATASET = `e2e-support-${suffix}`;
const RUN = `e2e-sft-${suffix}`;
const MODEL = "test/tiny-qwen3";
const TEACHER = "test/tiny-qwen3-teacher";

let key = "";
let runId = "";
let artifactRef = "";

const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, token = admin()): Promise<T> => {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

/** Opens `path` signed in with `token` (the key a `grad ui` handoff or the login form leaves in sessionStorage). */
const open = async (page: Page, path: string, token = key) => {
  await page.addInitScript((k) => sessionStorage.setItem("grad.api_key", k), token);
  await page.goto(`${base()}${path}`);
};

/** The card whose heading starts with `title` (headings carry counts, e.g. "Checkpoints 3"). */
const card = (page: Page, title: string) => page.locator(".card").filter({ has: page.getByRole("heading", { name: new RegExp(`^${title}`) }) });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** Serious or critical WCAG 2.1 AA violations on the current page. */
const axeViolations = async (page: Page): Promise<string[]> => {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  });
};

test("signs in with a new scoped key and keeps it in this tab only", async ({ page }) => {
  const created = await api<{ secret: string }>("POST", "/v1/keys", {
    name: `e2e-${suffix}`,
    scopes: ["datasets:write", "runs:write", "artifacts:write", "sources:read"],
  });
  key = created.secret;

  await page.goto(`${base()}/runs`);
  await expect(page.getByRole("heading", { name: "Sign in to grad" })).toBeVisible();
  await page.getByLabel("API key").fill("grad_not_a_key");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("rejected");

  await page.getByLabel("API key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem("grad.api_key") !== null, localStorage.getItem("grad.api_key")])).toEqual([true, null]);
  expect(await axeViolations(page)).toEqual([]);
});

test("shows a pushed dataset's records, found with / and the filter box", async ({ page }) => {
  const records = Array.from({ length: 24 }, (_, i) => ({ session_id: `s${i}`, messages: [{ role: "user", content: `Reset my password ${i}` }, { role: "assistant", content: "Open Settings, then Security." }] }));
  await api("POST", `/v1/datasets/${DATASET}/records`, { records }, key);

  await open(page, "/datasets");
  await expect(page.getByRole("heading", { name: "Datasets", level: 1 })).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByLabel("Filter datasets")).toBeFocused();
  await page.keyboard.type(suffix);
  await expect(page).toHaveURL(new RegExp(`\\?q=${suffix}$`));
  await page.getByRole("row", { name: new RegExp(DATASET) }).click();
  await expect(page.getByRole("heading", { name: DATASET, level: 1 })).toBeVisible();
  await expect(page.locator(".record").first()).toContainText("Reset my password");
  expect(await axeViolations(page)).toEqual([]);
});

test("follows a run live to completion and opens its artifact", async ({ page }) => {
  const run = await api<{ id: string }>("POST", "/v1/runs", { dataset: DATASET, name: RUN, recipe: { kind: "sft", model: MODEL, batch_size: 4 }, max_cost_usd: 5 }, key);
  runId = run.id;

  // Not the Active tab: the reference worker can finish the run before the page loads.
  await open(page, `/runs?q=${RUN}`);
  await page.getByRole("row", { name: new RegExp(RUN) }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByRole("heading", { name: new RegExp(RUN), level: 1 })).toBeVisible();

  // Live: the stream drives the badge, the phases, the charts and the events to the end.
  await expect(page.locator("h1 [data-status]")).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
  await expect(page.locator(".steps li[aria-current=step]")).toHaveText("Done");
  await expect(page.locator(".chart canvas").first()).toBeVisible();
  await expect(page.getByLabel("Run events, newest first")).toContainText("Completed");
  await expect(page.locator(".led")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Promote" }).first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  const artifactLink = card(page, "Artifact").getByRole("link").first();
  artifactRef = (await artifactLink.textContent()) ?? "";
  expect(artifactRef).toMatch(new RegExp(`^${RUN}@`));
  await artifactLink.click();
  await expect(page.getByRole("heading", { name: artifactRef, level: 1 })).toBeVisible();
  await expect(page.locator("pre.code").first()).toContainText("grad.artifact/1");
  await expect(card(page, "Provenance")).toContainText(runId);
});

test("promotes a checkpoint, and asks before deleting the new artifact", async ({ page }) => {
  await open(page, `/runs/${runId}`);
  await page.getByRole("button", { name: "Promote" }).last().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Artifact name").fill(`${RUN}-early`);
  await dialog.getByRole("button", { name: "Promote" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Promoted to ${RUN}-early@` })).toBeVisible();

  await open(page, `/artifacts?q=${RUN}-early`);
  await page.getByRole("row", { name: new RegExp(`${RUN}-early@`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText("can't be undone");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/artifacts$/);
  await expect(page.getByRole("status").filter({ hasText: "Deleted" })).toBeVisible();
});

// The reference worker's artifacts aren't servable (format "reference"), so the
// eval compares two catalog models; compose smoke evals a real trained adapter.
test("compares two models against a baseline in an eval", async ({ page }) => {
  const ev = await api<{ id: string }>(
    "POST",
    "/v1/evals",
    { name: `e2e-compare-${suffix}`, models: [TEACHER, MODEL], baseline: MODEL, dataset: DATASET, limit: 6, rubric: [{ name: "quality", kind: "judge", model: "anthropic/claude-sonnet-5-5" }] },
    key,
  );
  await open(page, "/evals");
  await page.getByRole("row", { name: new RegExp(`e2e-compare-${suffix}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/evals/${ev.id}$`));
  await expect(page.locator("h1 [data-status]")).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
  const summary = card(page, "Summary");
  await expect(summary.getByRole("columnheader", { name: `vs ${MODEL}` })).toBeVisible();
  await expect(summary.locator("tbody tr")).toHaveCount(2);
  await expect(summary).toContainText(TEACHER);
  expect(await axeViolations(page)).toEqual([]);
});

test("keeps filters in the URL across a reload and a deep link", async ({ page }) => {
  await open(page, `/runs?status=completed&q=${RUN}`);
  await expect(page.getByRole("row", { name: new RegExp(RUN) })).toBeVisible();
  await expect(page.getByRole("button", { name: "Completed", pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "Failed" }).click();
  await expect(page).toHaveURL(new RegExp(`status=failed`));
  await expect(page.getByText("No runs match")).toBeVisible();
  await page.reload();
  await expect(page.getByText("No runs match")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("row", { name: new RegExp(RUN) })).toBeVisible();
});

test("compares two runs: tab counts, overlaid curves, results and the settings that differ", async ({ page }) => {
  const other = await api<{ id: string }>("POST", "/v1/runs", { dataset: DATASET, name: `${RUN}-lr`, recipe: { kind: "sft", model: MODEL, batch_size: 4, lr: 1e-4 }, max_cost_usd: 5 }, key);
  await expect.poll(async () => (await api<{ status: string }>("GET", `/v1/runs/${other.id}`, undefined, key)).status, { timeout: 90_000 }).toBe("completed");

  // Tab counts come from GET /v1/runs/counts and follow the filter like the list.
  await open(page, `/runs?q=${RUN}`);
  await expect(page.getByRole("button", { name: "All" })).toHaveText("All2");
  await expect(page.getByRole("button", { name: "Completed" })).toHaveText("Completed2");
  await expect(page.getByRole("button", { name: "Failed" })).toHaveText("Failed0");

  await page.getByLabel(`Compare ${RUN}`, { exact: true }).check();
  await expect(page.getByRole("button", { name: "Compare 1" })).toBeDisabled();
  await page.getByLabel(`Compare ${RUN}-lr`).check();
  await page.getByRole("link", { name: "Compare 2" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/compare\\?ids=${runId},${other.id}$`));
  await expect(page.getByRole("heading", { name: "Compare 2 runs", level: 1 })).toBeVisible();
  await expect(page.locator(".chart canvas")).toBeVisible();
  await expect(card(page, "Results")).toContainText("Final train loss");
  const settings = card(page, "Settings");
  await expect(settings.getByRole("rowheader", { name: "lr", exact: true })).toBeVisible();
  await expect(settings.getByRole("rowheader", { name: "batch_size" })).toHaveCount(0);
  await settings.getByLabel("Show identical").check();
  await expect(settings.getByRole("rowheader", { name: "batch_size" })).toBeVisible();
  await page.getByLabel("Metric").selectOption("lr");
  await expect(page.getByRole("heading", { name: "Learning rate" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The URL is the selection: a reload keeps it; removing a run leaves too few to compare.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Learning rate" })).toBeVisible();
  await page.getByRole("button", { name: `Remove ${RUN}-lr from the comparison` }).click();
  await expect(page).toHaveURL(new RegExp(`ids=${runId}$`));
  await expect(page.getByText("Pick two or more runs")).toBeVisible();
});

test("a read-only key sees the server's refusal, not a broken page", async ({ page }) => {
  const ro = await api<{ secret: string }>("POST", "/v1/keys", { name: `e2e-ro-${suffix}`, scopes: ["runs:read", "artifacts:read", "datasets:read"] });
  await open(page, `/runs/${runId}`, ro.secret);
  await page.getByRole("button", { name: "Promote" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Promote" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("h1 [data-status]")).toHaveAttribute("data-status", "completed");
});
