export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * The database's `now()`, carried forward on the host's monotonic clock, so
 * every replica writes and compares lease times on one clock: a skewed host
 * clock, or one that steps (NTP, a VM resume), moves nothing (r8 A8). `sync`
 * re-reads the database time (the midpoint of the round trip) to correct
 * drift.
 */
export const createDbAnchoredClock = (
  monotonicMs: () => number = () => performance.now(),
  wallMs: () => number = Date.now,
): Clock & { sync(dbNow: () => Promise<Date>): Promise<void> } => {
  // Until the first sync: the host clock.
  let anchorMs = wallMs();
  let anchoredAt = monotonicMs();

  return {
    now: () => new Date(anchorMs + (monotonicMs() - anchoredAt)),
    sync: async (dbNow) => {
      const sent = monotonicMs();
      const db = (await dbNow()).getTime();
      anchorMs = db;
      anchoredAt = (sent + monotonicMs()) / 2;
    },
  };
};

export const nowIso = (clock: Clock): string => clock.now().toISOString();

export const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

/**
 * Leases are reaped one heartbeat interval (lease/3) after they expire, so a
 * short database outage does not requeue every running job: workers get to
 * renew first. The repositories' listExpiredLeases use the same grace.
 */
export const leaseGraceCutoff = (now: Date, leaseSeconds: number): string =>
  new Date(now.getTime() - (leaseSeconds / 3) * 1000).toISOString();
