import type { ChatMessage, DatasetRecord, EvalRubricItem } from "./generated/models.js";
import { GradUsageError } from "./errors.js";

/** What a local scorer function sees for one model output. */
export interface ScoreInput {
  output: string | null;
  expectedOutput: unknown;
  record: DatasetRecord;
  input: ChatMessage[];
  model: string;
  taskId: string;
  sampleIndex: number;
}

/** A scorer that runs in this process (`runtime: "local"`); return a score in [0, 1] or a boolean. */
export type ScoreFn = (output: string | null, input: ScoreInput) => number | boolean | Promise<number | boolean>;

/** A check the server runs itself (no code leaves your machine). */
export interface BuiltinValidator {
  readonly builtin: "json" | "non_empty" | "exact_match" | "regex";
  readonly pattern?: string;
  readonly flags?: string;
}

const isBuiltin = (fn: unknown): fn is BuiltinValidator =>
  typeof fn === "object" && fn !== null && typeof (fn as BuiltinValidator).builtin === "string";

const lastNumber = (text: string): number | undefined => {
  const matches = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/g);
  const last = matches?.[matches.length - 1];
  return last === undefined ? undefined : Number(last);
};

const expectedText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && typeof (value as { content?: unknown }).content === "string") {
    return (value as { content: string }).content;
  }
  return undefined;
};

/** Built-in validators. `json`, `nonEmpty`, `exactMatch` and `regex` run on the server; `numericMatch` runs locally. */
export const validators = {
  /** Output parses as JSON. */
  json: (): BuiltinValidator => ({ builtin: "json" }),
  /** Output is not blank. */
  nonEmpty: (): BuiltinValidator => ({ builtin: "non_empty" }),
  /** Output equals the record's expected output (trimmed). */
  exactMatch: (): BuiltinValidator => ({ builtin: "exact_match" }),
  /** Output matches an ECMAScript regex (bounded server-side; max 256 chars, flags from `imsu`). */
  regex: (pattern: string, options: { flags?: string } = {}): BuiltinValidator => ({
    builtin: "regex",
    pattern,
    ...(options.flags !== undefined ? { flags: options.flags } : {}),
  }),
  /**
   * The last number in the output equals the expected number: `record[field]`
   * when `field` is given (top level or `metadata`), else the expected output.
   * GSM8K-style answers (`#### 42`, `1,234`) are handled.
   */
  numericMatch:
    (options: { field?: string; tolerance?: number } = {}): ScoreFn =>
    (output, input) => {
      if (output === null) return 0;
      const record = input.record as Record<string, unknown>;
      const raw =
        options.field !== undefined
          ? (record[options.field] ?? (record.metadata as Record<string, unknown> | undefined)?.[options.field])
          : input.expectedOutput;
      const text = expectedText(raw);
      const expected = text === undefined ? undefined : lastNumber(text);
      const actual = lastNumber(output);
      if (expected === undefined || actual === undefined) return 0;
      return Math.abs(expected - actual) <= (options.tolerance ?? 1e-6) ? 1 : 0;
    },
};

const checkWeight = (name: string, weight: number | undefined): number | undefined => {
  if (weight === undefined) return undefined;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
    throw new GradUsageError(`Rubric item '${name}' needs a positive, finite weight (got ${String(weight)}).`, "invalid_rubric");
  }
  return weight;
};

/** A named check: a built-in validator (server-side) or your own function (local). */
export class Scorer {
  readonly name: string;
  readonly weight: number | undefined;
  readonly fn: BuiltinValidator | ScoreFn;

  constructor(name: string, options: { fn: BuiltinValidator | ScoreFn; weight?: number }) {
    if (!name) throw new GradUsageError("Scorer needs a name.", "invalid_rubric");
    if (typeof options.fn !== "function" && !isBuiltin(options.fn)) {
      throw new GradUsageError(`Scorer '${name}' needs fn: a validators.* check or a function.`, "invalid_rubric");
    }
    this.name = name;
    this.weight = checkWeight(name, options.weight);
    this.fn = options.fn;
  }

  /** True when the function runs in this process. */
  get isLocal(): boolean {
    return typeof this.fn === "function";
  }

  toWire(): EvalRubricItem {
    const weight = this.weight !== undefined ? { weight: this.weight } : {};
    if (typeof this.fn === "function") return { name: this.name, kind: "code", runtime: "local", ...weight };
    if (this.fn.builtin === "regex") {
      return {
        name: this.name,
        kind: "regex",
        pattern: this.fn.pattern ?? "",
        ...(this.fn.flags !== undefined ? { flags: this.fn.flags } : {}),
        ...weight,
      };
    }
    return { name: this.name, kind: "validator", validator: this.fn.builtin, ...weight };
  }
}

/** An LLM judge. `model` is required: there is no default judge that could change under you. */
export class Judge {
  readonly name: string;
  readonly model: string;
  readonly prompt: string | undefined;
  readonly weight: number | undefined;

  constructor(options: { name: string; model: string | { id: string } | { name: string; version: string }; prompt?: string; weight?: number }) {
    if (!options.name) throw new GradUsageError("Judge needs a name.", "invalid_rubric");
    const model =
      typeof options.model === "string"
        ? options.model
        : "version" in options.model && "name" in options.model
          ? `${options.model.name}@${options.model.version}`
          : (options.model as { id: string }).id;
    if (!model) throw new GradUsageError(`Judge '${options.name}' needs an explicit model.`, "invalid_rubric");
    this.name = options.name;
    this.model = model;
    this.prompt = options.prompt;
    this.weight = checkWeight(options.name, options.weight);
  }

  toWire(): EvalRubricItem {
    return {
      name: this.name,
      kind: "judge",
      model: this.model,
      ...(this.prompt !== undefined ? { prompt: this.prompt } : {}),
      ...(this.weight !== undefined ? { weight: this.weight } : {}),
    };
  }
}

export type RubricItem = Scorer | Judge;

/** A weighted set of checks. */
export class Rubric {
  readonly items: readonly RubricItem[];

  constructor(items: RubricItem[]) {
    if (items.length === 0) throw new GradUsageError("A Rubric needs at least one item.", "invalid_rubric");
    const names = new Set<string>();
    for (const item of items) {
      if (names.has(item.name)) throw new GradUsageError(`Rubric item names must be unique ('${item.name}' repeats).`, "invalid_rubric");
      names.add(item.name);
    }
    this.items = [...items];
  }

  toWire(): EvalRubricItem[] {
    return this.items.map((item) => item.toWire());
  }

  /** Local scorer functions by name. */
  localScorers(): Map<string, ScoreFn> {
    const out = new Map<string, ScoreFn>();
    for (const item of this.items) {
      if (item instanceof Scorer && typeof item.fn === "function") out.set(item.name, item.fn);
    }
    return out;
  }
}

export type RubricInput = Rubric | RubricItem | RubricItem[] | EvalRubricItem[];

export const toRubric = (input: RubricInput): { wire: EvalRubricItem[]; local: Map<string, ScoreFn> } => {
  if (input instanceof Rubric) return { wire: input.toWire(), local: input.localScorers() };
  if (input instanceof Scorer || input instanceof Judge) {
    const rubric = new Rubric([input]);
    return { wire: rubric.toWire(), local: rubric.localScorers() };
  }
  if (input.every((item) => item instanceof Scorer || item instanceof Judge)) {
    const rubric = new Rubric(input as RubricItem[]);
    return { wire: rubric.toWire(), local: rubric.localScorers() };
  }
  return { wire: input as EvalRubricItem[], local: new Map() };
};
