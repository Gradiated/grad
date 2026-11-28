/**
 * Five-field cron (`minute hour day-of-month month day-of-week`, UTC) for
 * source schedules: numbers, `*`, ranges `a-b`, steps `*\/n` or `a-b/n`, and
 * lists. When both day fields are restricted a day matches either, as in Vixie
 * cron. No names or `@hourly` shorthands.
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
  const anyDay = parts[2] === "*";
  const anyWeekday = parts[4] === "*";

  const dayMatches = (d: Date): boolean => {
    const dom = days.has(d.getUTCDate());
    const dow = weekdays.has(d.getUTCDay());
    if (anyDay && anyWeekday) return true;
    if (anyDay) return dow;
    if (anyWeekday) return dom;
    return dom || dow;
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
