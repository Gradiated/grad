export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const nowIso = (clock: Clock): string => clock.now().toISOString();

export const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);
