/**
 * Five-field cron (`minute hour day-of-month month day-of-week`, UTC) for
 * source schedules: numbers, `*`, ranges `a-b`, steps `*\/n` or `a-b/n`, and
 * lists. As in Vixie cron, a day matches either day field when neither
 * starts with `*`, else both (`*\/2 * 1`: odd days that are Mondays). No
 * names or `@hourly` shorthands.
 */
interface CronSchedule {
  readonly expression: string;
  /** The first matching minute strictly after `after`. */
  next(after: Date): Date;
}

interface Field {
  min: number;
  max: number;
}

const FIELDS: readonly Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

export class CronError extends Error {}

const parseNumber = (text: string, field: Field, name: string): number => {
  if (!/^\d{1,2}$/.test(text)) {
    throw new CronError(`Invalid ${name} '${text}'.`);
  }

  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw new CronError(
      `The ${name} ${value} is outside ${field.min}-${field.max}.`,
    );
  }

  return value;
};

const parseField = (text: string, index: number): Set<number> => {
  const field = FIELDS[index] as Field;
  const name = NAMES[index] as string;
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step =
      stepText === undefined
        ? 1
        : parseNumber(stepText, { min: 1, max: 59 }, `${name} step`);
    let [lo, hi] = [field.min, field.max];
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      lo = parseNumber(a, field, name);
      hi =
        b === undefined
          ? stepText === undefined
            ? lo
            : field.max
          : parseNumber(b, field, name);
      if (hi < lo) throw new CronError(`Invalid ${name} range '${range}'.`);
    }

    for (let v = lo; v <= hi; v += step)
      values.add(index === 4 && v === 7 ? 0 : v);
  }

  return values;
};

const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;
/** The most days each month can have (February in a leap year). */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const parseCron = (expression: string): CronSchedule => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `A schedule has five fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
    );
  }

  const [minutes, hours, days, months, weekdays] = parts.map(parseField) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const either = !parts[2]?.startsWith("*") && !parts[4]?.startsWith("*");
  // Days of the month alone (or with a starred weekday) must exist in some
  // listed month, else `next` would search for years ("0 0 30 2 *").
  if (
    !either &&
    !parts[2]?.startsWith("*") &&
    ![...months].some((m) =>
      [...days].some((d) => d <= (DAYS_IN_MONTH[m - 1] as number)),
    )
  ) {
    throw new CronError(`The schedule '${expression}' never fires.`);
  }

  const dayMatches = (d: Date): boolean => {
    const dom = days.has(d.getUTCDate());
    const dow = weekdays.has(d.getUTCDay());

    return either ? dom || dow : dom && dow;
  };

  return {
    expression: parts.join(" "),
    next: (after) => {
      const t = new Date(after.getTime());
      t.setUTCSeconds(0, 0);
      t.setUTCMinutes(t.getUTCMinutes() + 1);

      for (let guard = 0; guard < MAX_SEARCH_MINUTES; guard += 1) {
        if (!months.has(t.getUTCMonth() + 1)) {
          t.setUTCMonth(t.getUTCMonth() + 1, 1);
          t.setUTCHours(0, 0);
        } else if (!dayMatches(t)) {
          t.setUTCDate(t.getUTCDate() + 1);
          t.setUTCHours(0, 0);
        } else if (!hours.has(t.getUTCHours())) {
          t.setUTCHours(t.getUTCHours() + 1, 0);
        } else if (!minutes.has(t.getUTCMinutes())) {
          t.setUTCMinutes(t.getUTCMinutes() + 1);
        } else {
          return new Date(t.getTime());
        }
      }

      throw new CronError(`The schedule '${expression}' never fires.`);
    },
  };
};
