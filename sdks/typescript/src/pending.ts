/**
 * A create call: `await` it for the created resource, or chain `.wait()` to
 * block until it finishes (`grad.runs.create({...}).wait()`).
 */
export class Pending<T extends { wait(options?: O): Promise<R> }, R, O> implements PromiseLike<T> {
  constructor(private readonly promise: Promise<T>) {}

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<R2 = never>(onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<T | R2> {
    return this.promise.catch(onrejected);
  }

  /** Waits for the created resource to finish. */
  async wait(options?: O): Promise<R> {
    return (await this.promise).wait(options);
  }
}
