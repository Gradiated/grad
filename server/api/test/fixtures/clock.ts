import type { Clock } from "../../src/clock.js";

/** Injectable test clock: starts at a fixed instant and only moves when told. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: string | Date = "2026-11-27T12:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  now = (): Date => new Date(this.current);

  advance = (ms: number): void => {
    this.current += ms;
  };

  advanceSeconds = (seconds: number): void => this.advance(seconds * 1000);

  advanceDays = (days: number): void => this.advance(days * 86_400_000);

  set = (at: string | Date): void => {
    this.current = new Date(at).getTime();
  };
}
