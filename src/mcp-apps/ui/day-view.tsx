/** @jsxImportSource react */
import { useRef, useState } from "react";
import { z } from "zod";
import { activityData, ActivityPanel, activityTitle, type ActivityData } from "./activity-view";
import { GoalRings, LineChart, SegmentedBar, Stat, type Badge, type Point } from "./chart";
import { count, hoursMinutes, longDate, shiftDate, timeOfDay, words, type Measure } from "./format";
import {
  callTool,
  readResult,
  shareWithModel,
  Status,
  useHost,
  type Loaded,
  type ViewProps,
} from "./host";

const num = z.number().finite();
const opt = num.nullish().catch(null);
const samples = z.record(z.string(), num).nullish().catch(null);

const timing = { startTimeInSeconds: opt, startTimeOffsetInSeconds: opt, durationInSeconds: opt };

const daily = z.looseObject({
  ...timing,
  steps: opt,
  stepsGoal: opt,
  distanceInMeters: opt,
  activeKilocalories: opt,
  floorsClimbed: opt,
  floorsClimbedGoal: opt,
  moderateIntensityDurationInSeconds: opt,
  vigorousIntensityDurationInSeconds: opt,
  intensityDurationGoalInSeconds: opt,
  restingHeartRateInBeatsPerMinute: opt,
  minHeartRateInBeatsPerMinute: opt,
  maxHeartRateInBeatsPerMinute: opt,
  averageStressLevel: opt,
  bodyBatteryChargedValue: opt,
  bodyBatteryDrainedValue: opt,
  timeOffsetHeartRateSamples: samples,
});

const sleep = z.looseObject({
  ...timing,
  deepSleepDurationInSeconds: opt,
  lightSleepDurationInSeconds: opt,
  remSleepInSeconds: opt,
  awakeDurationInSeconds: opt,
  overallSleepScore: z
    .looseObject({ value: opt, qualifierKey: z.string().nullish().catch(null) })
    .nullish()
    .catch(null),
});

const hrv = z.looseObject({ ...timing, lastNightAvg: opt, lastNight5MinHigh: opt });

const stress = z.looseObject({ ...timing, timeOffsetBodyBatteryValues: samples });

const dayRecord = z.looseObject({
  summaryId: z.string(),
  summary: z.record(z.string(), z.unknown()).optional(),
  activityId: z.string().nullable().optional(),
});

const daySection = z.looseObject({ availability: z.string(), records: z.array(dayRecord) });

export const dayData = z.looseObject({
  date: z.string(),
  sections: z.record(z.string(), daySection),
});

type DayData = z.infer<typeof dayData>;

function present(value: Measure): value is number {
  return value !== undefined && value !== null;
}

function minutes(seconds: Measure): string {
  return count(present(seconds) ? seconds / 60 : null);
}

type Timed = {
  startTimeInSeconds?: Measure;
  startTimeOffsetInSeconds?: Measure;
  durationInSeconds?: Measure;
};

type PanelProps = { data: DayData; onOpen: (activityId: string) => void };

type Domain = [number, number];

/** The most complete summary of one type for the day: Garmin resends dailies as the day grows. */
function latest<T extends Timed>(data: DayData, type: string, schema: z.ZodType<T>): T | undefined {
  const parsed = (data.sections[type]?.records ?? []).flatMap((record) => {
    const result = schema.safeParse(record.summary);

    return result.success ? [result.data] : [];
  });

  return parsed.toSorted((a, b) => (a.durationInSeconds ?? 0) - (b.durationInSeconds ?? 0)).at(-1);
}

/** Garmin time-offset maps are seconds after the summary start; plot them on the local clock. */
function clockSeries(
  summary: Timed | undefined,
  values: Record<string, number> | null | undefined,
): Point[] {
  if (!summary?.startTimeInSeconds || !values) {
    return [];
  }

  const localStart = summary.startTimeInSeconds + (summary.startTimeOffsetInSeconds ?? 0);
  const midnight = Math.floor(localStart / 86_400) * 86_400;

  return (
    Object.entries(values)
      .map(([offset, y]) => ({ x: localStart + Number(offset) - midnight, y }))
      // Negative stress/battery values are Garmin's "not measured" markers.
      .filter((p) => Number.isFinite(p.x) && p.y >= 0)
      .toSorted((a, b) => a.x - b.x)
  );
}

const labels = new Map([
  ["dailies", "Daily summary"],
  ["epochs", "Epochs"],
  ["sleeps", "Sleep"],
  ["bodyComps", "Body composition"],
  ["stressDetails", "Stress"],
  ["userMetrics", "Fitness metrics"],
  ["pulseox", "Pulse Ox"],
  ["allDayRespiration", "Respiration"],
  ["healthSnapshot", "Health Snapshot"],
  ["hrv", "HRV"],
  ["bloodPressures", "Blood pressure"],
  ["skinTemp", "Skin temperature"],
]);

/** Garmin's stress ranges: 0–25 rest, 26–50 low, 51–75 medium, 76–100 high. */
function stressBadge(level: number | null): Badge | undefined {
  if (level === null) {
    return undefined;
  }

  if (level <= 25) {
    return { text: "Rest", tone: "good" };
  }

  if (level <= 50) {
    return { text: "Low", tone: "good" };
  }

  return { text: level <= 75 ? "Medium" : "High", tone: "attention" };
}

const goodSleep = new Set(["EXCELLENT", "GOOD"]);

function today(timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function DayPanel({ data, onOpen }: PanelProps) {
  const d = latest(data, "dailies", daily);
  const night = latest(data, "sleeps", sleep);
  const variability = latest(data, "hrv", hrv);
  const battery = latest(data, "stressDetails", stress);

  const intensity =
    d &&
    (present(d.moderateIntensityDurationInSeconds) || present(d.vigorousIntensityDurationInSeconds))
      ? (d.moderateIntensityDurationInSeconds ?? 0) +
        2 * (d.vigorousIntensityDurationInSeconds ?? 0)
      : null;

  const heartRate = clockSeries(d, d?.timeOffsetHeartRateSamples);
  const bodyBattery = clockSeries(battery, battery?.timeOffsetBodyBatteryValues);

  const activities = (data.sections.activities?.records ?? []).flatMap((r) =>
    r.activityId ? [r.activityId] : [],
  );

  const denied = Object.entries(data.sections).filter(
    ([, s]) => s.availability === "permission_denied",
  );

  const missing = Object.entries(data.sections).flatMap(([type, s]) => {
    const label = labels.get(type);

    return s.availability === "not_received" && label ? [label] : [];
  });

  const day: Domain = [0, 86_400];

  const stressLevel =
    present(d?.averageStressLevel) && d.averageStressLevel >= 0 ? d.averageStressLevel : null;

  const score = night?.overallSleepScore;

  const heartRange = d
    ? `${count(d.minHeartRateInBeatsPerMinute)}–${count(d.maxHeartRateInBeatsPerMinute)} bpm`
    : undefined;

  return (
    <>
      {d ? (
        <GoalRings
          goals={[
            {
              label: "Steps",
              value: d.steps,
              goal: d.stepsGoal,
              display: `${count(d.steps)} / ${count(d.stepsGoal)}`,
              color: "var(--series-1)",
            },
            {
              label: "Intensity minutes",
              value: intensity,
              goal: d.intensityDurationGoalInSeconds,
              display: `${minutes(intensity)} / ${minutes(d.intensityDurationGoalInSeconds)}`,
              color: "var(--series-2)",
            },
            {
              label: "Floors",
              value: d.floorsClimbed,
              goal: d.floorsClimbedGoal,
              display: `${count(d.floorsClimbed)} / ${count(d.floorsClimbedGoal)}`,
              color: "var(--series-3)",
            },
          ]}
        />
      ) : (
        <p className="muted">
          No daily summary was received for this day. Missing data does not mean zero.
        </p>
      )}

      <div className="grid">
        <Stat
          label="Resting HR"
          value={count(d?.restingHeartRateInBeatsPerMinute)}
          unit="bpm"
          note={`range ${count(d?.minHeartRateInBeatsPerMinute)}–${count(d?.maxHeartRateInBeatsPerMinute)}`}
        />
        <Stat
          label="HRV last night"
          value={count(variability?.lastNightAvg)}
          unit="ms"
          note={`5-min high ${count(variability?.lastNight5MinHigh)} ms`}
        />
        <Stat
          label="Avg stress"
          value={count(stressLevel)}
          unit="/ 100"
          badge={stressBadge(stressLevel)}
        />
        <Stat
          label="Body Battery"
          value={`+${count(d?.bodyBatteryChargedValue)} / −${count(d?.bodyBatteryDrainedValue)}`}
          note="charged / drained"
        />
        <Stat
          label="Distance"
          value={present(d?.distanceInMeters) ? count(d.distanceInMeters / 1000, 1) : count(null)}
          unit="km"
        />
        <Stat label="Active calories" value={count(d?.activeKilocalories)} unit="kcal" />
      </div>

      <LineChart
        label="Heart rate (bpm)"
        summary={heartRange}
        points={heartRate}
        formatX={timeOfDay}
        formatY={(v) => count(v)}
        xDomain={day}
        xSeconds
        color="var(--series-2)"
        area
      />
      <LineChart
        label="Body Battery"
        summary={
          d
            ? `+${count(d.bodyBatteryChargedValue)} / −${count(d.bodyBatteryDrainedValue)}`
            : undefined
        }
        points={bodyBattery}
        formatX={timeOfDay}
        formatY={(v) => count(v)}
        xDomain={day}
        xSeconds
        area
      />

      {night && (
        <section className="card section" aria-label="Sleep">
          <div className="section-head">
            <h2>Sleep</h2>
            {present(score?.value) && (
              <span
                className={`badge ${score.qualifierKey && goodSleep.has(score.qualifierKey) ? "good" : "neutral"}`}
              >
                Score {count(score.value)}
                {score.qualifierKey ? ` · ${words(score.qualifierKey)}` : ""}
              </span>
            )}
          </div>
          <div className="sleep-headline">
            <span className="display">{hoursMinutes(night.durationInSeconds)}</span>
            <span className="muted">asleep</span>
          </div>
          <SegmentedBar
            label="Sleep stages"
            format={hoursMinutes}
            parts={[
              {
                label: "Deep",
                value: night.deepSleepDurationInSeconds ?? 0,
                color: "var(--seq-5)",
              },
              {
                label: "Light",
                value: night.lightSleepDurationInSeconds ?? 0,
                color: "var(--seq-2)",
              },
              { label: "REM", value: night.remSleepInSeconds ?? 0, color: "var(--series-3)" },
              {
                label: "Awake",
                value: night.awakeDurationInSeconds ?? 0,
                color: "var(--series-4)",
              },
            ]}
          />
        </section>
      )}

      {activities.length > 0 && (
        <section className="card section">
          <h2>Activities</h2>
          <ul className="rows">
            {activities.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className="row-button"
                  aria-label={`Open activity ${id} →`}
                  onClick={() => onOpen(id)}
                >
                  <span>Activity {id}</span>
                  <span className="chevron" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(missing.length > 0 || denied.length > 0) && (
        <section className="section">
          {missing.length > 0 && (
            <p className="muted">Not received for this day: {missing.join(", ")}.</p>
          )}
          {denied.length > 0 && (
            <p className="muted">
              Some categories are hidden because Garmin sharing permission is off.
            </p>
          )}
        </section>
      )}
    </>
  );
}

type Screen =
  | { kind: "day"; date?: string; loaded: Loaded<DayData> }
  | { kind: "activity"; day: Loaded<DayData>; loaded: Loaded<ActivityData | null> };

export function DayView({ tool }: ViewProps) {
  const { app, context } = useHost();
  const navigation = useRef(0);
  const [screen, setScreen] = useState<Screen | null>(null);
  const current: Screen = screen ?? { kind: "day", loaded: readResult(tool.result, dayData) };
  const input = z.object({ date: z.string() }).safeParse(tool.input);

  const goTo = async (date: string) => {
    const request = ++navigation.current;
    setScreen({ kind: "day", date, loaded: { state: "loading" } });
    const loaded = await callTool(app, "get_garmin_day", { date }, dayData);
    if (request !== navigation.current) {
      return;
    }

    setScreen({ kind: "day", date, loaded });
    shareWithModel(app, `The user is viewing their Garmin day ${date} in the day view.`);
  };

  if (current.kind === "activity") {
    const back = () => {
      navigation.current++;
      setScreen({ kind: "day", loaded: current.day });
    };

    return (
      <>
        <header className="header">
          <button type="button" className="button" onClick={back}>
            ← Back to day
          </button>
          <h1>
            {current.loaded.state === "ready" && current.loaded.data
              ? activityTitle(current.loaded.data)
              : "Activity"}
          </h1>
        </header>
        {current.loaded.state === "ready" ? (
          current.loaded.data ? (
            <ActivityPanel data={current.loaded.data} />
          ) : (
            <p className="muted">This activity has not been received from Garmin.</p>
          )
        ) : (
          <Status loaded={current.loaded} what="activity" />
        )}
      </>
    );
  }

  const loaded = current.loaded;

  const date =
    loaded.state === "ready"
      ? loaded.data.date
      : (current.date ?? (input.success ? input.data.date : undefined));

  const open = async (activityId: string) => {
    const request = ++navigation.current;
    setScreen({ kind: "activity", day: loaded, loaded: { state: "loading" } });
    const activity = await callTool(app, "get_garmin_activity", { activityId }, activityData);
    if (request !== navigation.current) {
      return;
    }

    setScreen({ kind: "activity", day: loaded, loaded: activity });
    shareWithModel(app, `The user opened Garmin activity ${activityId} from the day view.`);
  };

  return (
    <>
      <header className="header">
        <h1>
          <span className="eyebrow">Garmin day</span>
          {date ? longDate(date) : "Your day"}
        </h1>
        {date && app && (
          <nav className="pager" aria-label="Day">
            <button
              type="button"
              className="button icon"
              aria-label="Previous day"
              onClick={() => void goTo(shiftDate(date, -1))}
            >
              ‹
            </button>
            <button
              type="button"
              className="button icon"
              aria-label="Next day"
              disabled={date >= today(context.timeZone)}
              onClick={() => void goTo(shiftDate(date, 1))}
            >
              ›
            </button>
          </nav>
        )}
      </header>
      {loaded.state === "ready" ? (
        <DayPanel data={loaded.data} onOpen={(id) => void open(id)} />
      ) : (
        <Status loaded={loaded} what="day" />
      )}
    </>
  );
}
