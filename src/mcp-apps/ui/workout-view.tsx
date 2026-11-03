/** @jsxImportSource react */
import { useState } from "react";
import { z } from "zod";
import { Stat } from "./chart";
import { clock, count, DASH, hoursMinutes, kilometers, pace, words, type Measure } from "./format";
import { readResult, Status, useHost, type ViewProps } from "./host";

const num = z.number().finite();
const opt = num.nullish().catch(null);
const text = z.string().nullish().catch(null);

const step = z.looseObject({
  type: z.string(),
  stepOrder: num,
  intensity: text,
  description: text,
  durationType: text,
  durationValue: opt,
  targetType: text,
  targetValue: opt,
  targetValueLow: opt,
  targetValueHigh: opt,
  targetValueType: text,
  exerciseName: text,
  exerciseCategory: text,
  weightValue: opt,
  repeatValue: opt,
  steps: z
    .array(z.looseObject({ type: z.string(), stepOrder: num }))
    .nullish()
    .catch(null),
});

type Step = z.infer<typeof step>;

const workout = z.looseObject({
  workoutId: num,
  workoutName: z.string(),
  sport: z.string(),
  description: text,
  segments: z.array(z.looseObject({ segmentOrder: num, sport: z.string(), steps: z.array(step) })),
});

export const workoutData = z.union([workout, z.looseObject({ accepted: z.literal(true) })]);

type Workout = z.infer<typeof workout>;

/** Three intensity groups, in fixed categorical order (validated all-pairs for slots 1–3). */
const groups = {
  recovery: { label: "Recovery / rest", color: "var(--series-1)" },
  work: { label: "Work", color: "var(--series-2)" },
  easy: { label: "Warm-up / cool-down", color: "var(--series-3)" },
} as const;

type Group = keyof typeof groups;

/** Bar height is relative effort: rest lowest, intervals tallest. */
type Effort = { group: Group; height: number };

const efforts = new Map<string, Effort>([
  ["REST", { group: "recovery", height: 0.2 }],
  ["RECOVERY", { group: "recovery", height: 0.32 }],
  ["WARMUP", { group: "easy", height: 0.48 }],
  ["COOLDOWN", { group: "easy", height: 0.48 }],
  ["ACTIVE", { group: "work", height: 0.74 }],
  ["MAIN", { group: "work", height: 0.74 }],
  ["INTERVAL", { group: "work", height: 1 }],
]);

const fallbackEffort: Effort = { group: "work", height: 0.6 };

function effort(s: Step): Effort {
  return efforts.get(s.intensity ?? "") ?? fallbackEffort;
}

/** Meters per second used only to size distance steps without a pace target. */
const defaultSpeed = new Map([
  ["RUNNING", 3],
  ["CYCLING", 7],
  ["LAP_SWIMMING", 0.9],
]);

type Repeat = { id: number; label: string };

type Estimate = { seconds: number; estimated: boolean };

type Block = Estimate & { step: Step; repeat?: Repeat };

type ProfileProps = { data: Block[] };

type StepProps = { s: Step };

type ScheduleProps = { data: Workout };

function estimate(s: Step, sport: string): Estimate {
  const value = s.durationValue;

  switch (s.durationType ?? "") {
    case "TIME":
      return { seconds: value ?? 60, estimated: value === undefined || value === null };
    case "DISTANCE": {
      const target =
        (s.targetType === "PACE" || s.targetType === "SPEED") &&
        s.targetValueLow &&
        s.targetValueHigh
          ? (s.targetValueLow + s.targetValueHigh) / 2
          : undefined;

      return { seconds: (value ?? 0) / (target ?? defaultSpeed.get(sport) ?? 2), estimated: true };
    }

    case "REPS":
      return { seconds: (value ?? 10) * 4, estimated: true };

    default:
      return { seconds: 60, estimated: true };
  }
}

function blocks(data: Workout): Block[] {
  let repeatId = 0;

  return data.segments.flatMap((segment) =>
    segment.steps.flatMap((s): Block[] => {
      if (s.type !== "WorkoutRepeatStep") {
        return [{ step: s, ...estimate(s, segment.sport) }];
      }

      repeatId += 1;

      const children = (s.steps ?? []).flatMap((child) => {
        const parsed = step.safeParse(child);

        return parsed.success ? [parsed.data] : [];
      });

      const times = Math.max(1, s.repeatValue ?? 1);
      const repeat = { id: repeatId, label: `×${times}` };

      return Array.from({ length: times }, () =>
        children.map((child) => ({ step: child, repeat, ...estimate(child, segment.sport) })),
      ).flat();
    }),
  );
}

function durationLabel(s: Step): string {
  const value = s.durationValue;

  switch (s.durationType ?? "") {
    case "TIME":
      return clock(value);
    case "DISTANCE":
      return value !== undefined && value !== null && value < 1000
        ? `${count(value)} m`
        : kilometers(value);

    case "REPS":
      return `${count(value)} reps`;

    default:
      return "Until lap button";
  }
}

function targetLabel(s: Step): string {
  const low: Measure = s.targetValueLow;
  const high: Measure = s.targetValueHigh;
  const percent = s.targetValueType === "PERCENT" ? "%" : "";

  switch (s.targetType ?? "") {
    case "PACE":
      return `${pace(high)} – ${pace(low)}`;
    case "SPEED":
      return `${count(low && low * 3.6, 1)}–${count(high && high * 3.6, 1)} km/h`;
    case "HEART_RATE":
      return s.targetValue
        ? `HR zone ${s.targetValue}`
        : `${count(low)}–${count(high)}${percent || " bpm"}`;
    case "POWER":
      return s.targetValue
        ? `Power zone ${s.targetValue}`
        : `${count(low)}–${count(high)}${percent || " W"}`;
    case "CADENCE":
      return `${count(low)}–${count(high)} rpm`;
    case "SWIM_STROKE":
      return "Stroke";

    default:
      return "No target";
  }
}

function stepTitle(s: Step): string {
  const name = s.exerciseName ?? s.exerciseCategory;

  return name ? words(name) : words(s.intensity ?? "Step");
}

const PROFILE = { width: 640, height: 150, top: 22, gap: 2 };

function Profile({ data }: ProfileProps) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((sum, b) => sum + b.seconds, 0) || 1;
  const usable = PROFILE.width - PROFILE.gap * Math.max(0, data.length - 1);
  const plot = PROFILE.height - PROFILE.top;
  let x = 0;

  const placed = data.map((b) => {
    const width = Math.max(2, (b.seconds / total) * usable);
    const level = effort(b.step);
    const item = { ...b, x, width, height: level.height * plot, group: level.group };
    x += width + PROFILE.gap;

    return item;
  });

  const brackets = [...new Set(placed.flatMap((p) => (p.repeat ? [p.repeat.id] : [])))].map(
    (id) => {
      const members = placed.filter((p) => p.repeat?.id === id);
      const first = members[0];
      const last = members.at(-1);

      return {
        id,
        label: first?.repeat?.label ?? "",
        x1: first?.x ?? 0,
        x2: (last?.x ?? 0) + (last?.width ?? 0),
      };
    },
  );

  const shown = hover === null ? undefined : placed[hover];

  return (
    <figure className="chart profile">
      <figcaption>Workout profile</figcaption>
      <div className="chart-frame">
        <svg
          viewBox={`0 0 ${PROFILE.width} ${PROFILE.height}`}
          role="img"
          aria-label="Workout steps by estimated duration and intensity"
          onPointerLeave={() => setHover(null)}
        >
          {brackets.map((b) => (
            <g key={b.id}>
              <path className="axis-line" fill="none" d={`M${b.x1},14V8H${b.x2}V14`} />
              <text className="tick" x={(b.x1 + b.x2) / 2} y={5} textAnchor="middle">
                {b.label}
              </text>
            </g>
          ))}
          {placed.map((p, i) => {
            const y = PROFILE.height - p.height;
            const r = Math.min(4, p.width / 2);

            return (
              <path
                key={i}
                d={`M${p.x},${PROFILE.height}V${y + r}Q${p.x},${y} ${p.x + r},${y}H${p.x + p.width - r}Q${p.x + p.width},${y} ${p.x + p.width},${y + r}V${PROFILE.height}Z`}
                fill={groups[p.group].color}
                opacity={hover === null || hover === i ? 1 : 0.45}
                onPointerEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
              />
            );
          })}
        </svg>
        {shown && (
          <div
            className="tooltip"
            style={{
              left: `${Math.min(85, Math.max(15, ((shown.x + shown.width / 2) / PROFILE.width) * 100))}%`,
            }}
          >
            <strong>{stepTitle(shown.step)}</strong> · {durationLabel(shown.step)} ·{" "}
            {targetLabel(shown.step)}
          </div>
        )}
      </div>
      <ul className="legend">
        {Object.values(groups).map((g) => (
          <li key={g.label}>
            <span className="swatch" style={{ background: g.color }} />
            {g.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}

function StepLine({ s }: StepProps) {
  return (
    <li>
      <span className="swatch" style={{ background: groups[effort(s).group].color }} />
      <span>
        <strong>{stepTitle(s)}</strong> · {durationLabel(s)} · {targetLabel(s)}
        {s.weightValue ? ` · ${count(s.weightValue, 1)} kg` : ""}
        {s.description ? <span className="muted"> — {s.description}</span> : null}
      </span>
    </li>
  );
}

function Schedule({ data }: ScheduleProps) {
  const { app, context } = useHost();

  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: context.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );

  const [sent, setSent] = useState(false);

  if (!app?.getHostCapabilities()?.message) {
    return null;
  }

  // The model confirms and performs the write; the view never schedules on its own.
  const ask = () => {
    app
      .sendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: `Schedule my Garmin workout "${data.workoutName}" (workoutId ${data.workoutId}) on ${date}.`,
          },
        ],
      })
      .then(() => setSent(true))
      .catch(() => setSent(false));
  };

  return (
    <div className="schedule">
      <label className="muted" htmlFor="schedule-date">
        Put it on the calendar
      </label>
      <input
        id="schedule-date"
        type="date"
        value={date}
        onChange={(event) => setDate(event.currentTarget.value)}
      />
      <button type="button" className="button" onClick={ask} disabled={sent || !date}>
        {sent ? "Asked" : "Ask to schedule"}
      </button>
    </div>
  );
}

export function WorkoutView({ tool }: ViewProps) {
  const loaded = readResult(tool.result, workoutData);

  if (loaded.state !== "ready") {
    return <Status loaded={loaded} what="workout" />;
  }

  if ("accepted" in loaded.data) {
    return (
      <p className="muted">
        Garmin accepted the change but returned no workout details. Check Garmin Connect before
        retrying.
      </p>
    );
  }

  const data = loaded.data;
  const plan = blocks(data);
  const seconds = plan.reduce((sum, b) => sum + b.seconds, 0);
  const estimated = plan.some((b) => b.estimated);

  const meters = plan.reduce(
    (sum, b) => sum + (b.step.durationType === "DISTANCE" ? (b.step.durationValue ?? 0) : 0),
    0,
  );

  const deviceSync = z.string().optional().safeParse(loaded.envelope.deviceSync);

  return (
    <>
      <header className="header">
        <h1>
          <span className="eyebrow">Garmin workout · {words(data.sport)}</span>
          {data.workoutName}
        </h1>
      </header>
      {data.description && <p className="muted">{data.description}</p>}
      <div className="grid">
        <Stat
          label={estimated ? "Estimated time" : "Time"}
          value={seconds ? hoursMinutes(seconds) : DASH}
        />
        <Stat label="Steps" value={count(plan.length)} note="repeats expanded" />
        {meters > 0 && <Stat label="Distance in steps" value={kilometers(meters)} />}
      </div>
      {plan.length > 0 && <Profile data={plan} />}
      {data.segments.map((segment) => (
        <section className="section" key={segment.segmentOrder}>
          {data.segments.length > 1 && <h2>{words(segment.sport)}</h2>}
          <ol className="steps">
            {segment.steps.map((s) =>
              s.type === "WorkoutRepeatStep" ? (
                <li key={s.stepOrder}>
                  <span>
                    <strong>Repeat ×{count(s.repeatValue)}</strong>
                    <ol className="steps repeat">
                      {(s.steps ?? []).flatMap((child) => {
                        const parsed = step.safeParse(child);

                        return parsed.success
                          ? [<StepLine key={parsed.data.stepOrder} s={parsed.data} />]
                          : [];
                      })}
                    </ol>
                  </span>
                </li>
              ) : (
                <StepLine key={s.stepOrder} s={s} />
              ),
            )}
          </ol>
        </section>
      ))}
      {deviceSync.success && deviceSync.data && <p className="muted">{deviceSync.data}</p>}
      <Schedule data={data} />
    </>
  );
}
