export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * The host clock shifted to agree with the database's `now()`, so every
 * replica writes and compares lease times on one clock however skewed its
 * host is. `sync` measures the offset (midpoint of the round trip).
 */
export const createDbAnchoredClock = (
  hostNow: () => number = Date.now,
): Clock & { sync(dbNow: () => Promise<Date>): Promise<void> } => {
  let offsetMs = 0;

  return {
    now: () => new Date(hostNow() + offsetMs),
    sync: async (dbNow) => {
      const sent = hostNow();
      const db = (await dbNow()).getTime();
      offsetMs = Math.round(db - (sent + hostNow()) / 2);
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
