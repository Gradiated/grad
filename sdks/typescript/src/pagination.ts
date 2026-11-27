import { APIUserAbortError, type RequestOptions } from "./generated/transport.js";
import { GradUsageError, PaginationLoopError } from "./errors.js";

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Default cap for `Paginator.all()`; iterate with `for await` for larger lists. */
export const DEFAULT_MAX_ITEMS = 100_000;

const aborted = (signal: AbortSignal): APIUserAbortError =>
  new APIUserAbortError("Listing aborted.", { code: "aborted", cause: signal.reason });

/**
 * Walks a cursor-paged endpoint page by page. Stops when the server returns no
 * cursor or an empty page, throws PaginationLoopError when a cursor repeats
 * (following it would never end), and checks `signal` before every request.
 * Each request still carries its own per-request timeout.
 */
export async function* pages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  signal?: AbortSignal,
  first?: Promise<Page<T>>,
): AsyncGenerator<Page<T>, void, undefined> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pending = first;
  while (true) {
    if (signal?.aborted) throw aborted(signal);
    const page = await (pending ?? fetchPage(cursor));
    pending = undefined;
    yield page;
    const next = page.nextCursor;
    if (!next || page.data.length === 0) return;
    if (seen.has(next)) throw new PaginationLoopError(next);
    seen.add(next);
    cursor = next;
  }
}

/** Collects every item of a paged endpoint, bounded by `maxItems` (default 100,000). */
export const collect = async <T>(source: AsyncIterable<Page<T>>, maxItems = DEFAULT_MAX_ITEMS): Promise<T[]> => {
  const out: T[] = [];
  for await (const page of source) {
    if (out.length + page.data.length > maxItems) {
      throw new GradUsageError(`The listing has more than ${maxItems} items; iterate it with \`for await\` instead of collecting it.`, "too_many_items");
    }
    out.push(...page.data);
  }
  return out;
};

/**
 * A list call: `await` it for the first page, or `for await` it to walk every
 * item across pages.
 */
export class Paginator<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  private first: Promise<Page<T>> | undefined;

  constructor(
    private readonly fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
    private readonly signal?: AbortSignal | undefined,
  ) {}

  private firstPage(): Promise<Page<T>> {
    this.first ??= this.fetchPage(undefined);
    return this.first;
  }

  then<R1 = Page<T>, R2 = never>(
    onfulfilled?: ((value: Page<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.firstPage().then(onfulfilled, onrejected);
  }

  /** Every page, in order (stops on a repeated cursor with PaginationLoopError). */
  pages(): AsyncGenerator<Page<T>, void, undefined> {
    return pages(this.fetchPage, this.signal, this.signal?.aborted ? undefined : this.firstPage());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for await (const page of this.pages()) yield* page.data;
  }

  /** Collects every item; throws GradUsageError past `maxItems` (default 100,000). */
  all(options: { maxItems?: number } = {}): Promise<T[]> {
    return collect(this.pages(), options.maxItems);
  }
}

/** The list-call options every paged method accepts. */
export type ListOptions = { limit?: number } & RequestOptions;
