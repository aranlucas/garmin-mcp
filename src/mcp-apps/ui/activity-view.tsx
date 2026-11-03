/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { LineChart, Stat, type Point } from "./chart";
import { clock, count, DASH, kilometers, pace, words, type Measure } from "./format";
import { readResult, Status, type ViewProps } from "./host";

const num = z.number().finite();
const opt = num.nullish().catch(null);
const text = z.string().nullish().catch(null);

const fitRecord = z.looseObject({
  timestamp: opt,
  positionLat: opt,
  positionLong: opt,
  heartRate: opt,
  speed: opt,
  enhancedSpeed: opt,
  altitude: opt,
  enhancedAltitude: opt,
  distance: opt,
});

const lap = z.looseObject({
  totalDistance: opt,
  totalTimerTime: opt,
  avgHeartRate: opt,
  maxHeartRate: opt,
  avgSpeed: opt,
  enhancedAvgSpeed: opt,
  totalAscent: opt,
  totalCalories: opt,
});

const strengthSet = z.looseObject({
  index: num,
  setType: z.string().nullable().catch(null),
  durationSeconds: num.nullable().catch(null),
  repetitions: num.nullable().catch(null),
  weightKg: num.nullable().catch(null),
  exercises: z
    .array(z.looseObject({ name: z.string().nullable(), category: z.string().nullable() }))
    .catch([]),
});

const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().catch(null);

const fit = z.looseObject({
  availability: text,
  messages: z
    .looseObject({ recordMesgs: list(fitRecord), lapMesgs: list(lap), sessionMesgs: list(lap) })
    .nullish()
    .catch(null),
  sets: list(strengthSet),
});

const summary = z.looseObject({
  activityName: text,
  activityType: text,
  deviceName: text,
  durationInSeconds: opt,
  distanceInMeters: opt,
  averageHeartRateInBeatsPerMinute: opt,
  maxHeartRateInBeatsPerMinute: opt,
  averageSpeedInMetersPerSecond: opt,
  activeKilocalories: opt,
  totalElevationGainInMeters: opt,
  startTimeInSeconds: opt,
});

export const activityData = z
  .looseObject({
    activityId: z.string(),
    summary: summary.nullable().catch(null),
    fit: fit.nullable().catch(null),
  })
  .nullable();

export type ActivityData = NonNullable<z.infer<typeof activityData>>;

type Sample = {
  t: number;
  lat: Measure;
  lon: Measure;
  hr: Measure;
  speed: Measure;
  altitude: Measure;
  distance: Measure;
};

type Run = { bin: number; d: string };

type SampleProps = { data: Sample[]; index: number | null };

type ReplayProps = SampleProps & { onIndex: (i: number | null) => void };

type RouteProps = SampleProps & { children?: ReactNode };

type PanelProps = { data: ActivityData };

type Domain = [number, number];

function present(value: Measure): value is number {
  return value !== undefined && value !== null;
}

function degrees(semicircles: Measure): Measure {
  return present(semicircles) ? semicircles * SEMICIRCLE_TO_DEGREES : null;
}

const SEMICIRCLE_TO_DEGREES = 180 / 2 ** 31;
const MAX_SAMPLES = 1200;
const ROUTE = { width: 640, height: 360, pad: 16 };

const HEART_RATE_BINS = [
  "var(--seq-1)",
  "var(--seq-2)",
  "var(--seq-3)",
  "var(--seq-4)",
  "var(--seq-5)",
];

/** Evenly thinned FIT records, with elapsed seconds from the first timestamp. */
function samples(records: z.infer<typeof fitRecord>[]): Sample[] {
  const timed = records.filter((r) => present(r.timestamp));
  const stride = Math.max(1, Math.ceil(timed.length / MAX_SAMPLES));
  const start = timed[0]?.timestamp ?? 0;

  return timed.flatMap((r, i) =>
    i % stride === 0 || i === timed.length - 1
      ? [
          {
            t: (r.timestamp ?? start) - start,
            lat: degrees(r.positionLat),
            lon: degrees(r.positionLong),
            hr: r.heartRate,
            speed: r.enhancedSpeed ?? r.speed,
            altitude: r.enhancedAltitude ?? r.altitude,
            distance: r.distance,
          },
        ]
      : [],
  );
}

function series(data: Sample[], pick: (s: Sample) => Measure): Point[] {
  return data.flatMap((s) => {
    const y = pick(s);

    return present(y) ? [{ x: s.t, y }] : [];
  });
}

type Projected = { x: number; y: number; bin: number; index: number };

/** Equirectangular projection fitted to the frame; north up, aspect preserved. */
function project(data: Sample[]) {
  const located = data.flatMap((s, index) =>
    !present(s.lat) || !present(s.lon) || (s.lat === 0 && s.lon === 0)
      ? []
      : [{ lat: s.lat, lon: s.lon, hr: s.hr, index }],
  );

  if (located.length < 2) {
    return null;
  }

  const meanLat = located.reduce((sum, p) => sum + p.lat, 0) / located.length;
  const scaleX = Math.cos((meanLat * Math.PI) / 180);
  const xs = located.map((p) => p.lon * scaleX);
  const ys = located.map((p) => -p.lat);

  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];

  const span = Math.max(maxX - minX, maxY - minY) || 1e-9;

  const scale = Math.min(
    (ROUTE.width - 2 * ROUTE.pad) / (maxX - minX || span),
    (ROUTE.height - 2 * ROUTE.pad) / (maxY - minY || span),
  );

  const offsetX = (ROUTE.width - (maxX - minX) * scale) / 2;
  const offsetY = (ROUTE.height - (maxY - minY) * scale) / 2;
  const rates = located.flatMap((p) => (present(p.hr) ? [p.hr] : []));
  const low = Math.min(...rates);
  const high = Math.max(...rates);

  const points: Projected[] = located.map((p, i) => ({
    x: offsetX + ((xs[i] ?? 0) - minX) * scale,
    y: offsetY + ((ys[i] ?? 0) - minY) * scale,
    bin:
      !present(p.hr) || !rates.length
        ? 2
        : Math.min(4, Math.floor(((p.hr - low) / (high - low || 1)) * 5)),
    index: p.index,
  }));

  // Contiguous runs of one heart-rate bin become one path; adjacent runs share an endpoint.
  const runs: Run[] = [];

  for (const [i, p] of points.entries()) {
    const previous = points[i - 1];
    const last = runs.at(-1);

    if (!previous) {
      continue;
    }

    if (last && last.bin === p.bin) {
      last.d += `L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    } else {
      runs.push({
        bin: p.bin,
        d: `M${previous.x.toFixed(1)},${previous.y.toFixed(1)}L${p.x.toFixed(1)},${p.y.toFixed(1)}`,
      });
    }
  }

  return { points, runs, heartRate: rates.length ? { low, high } : null };
}

function RouteMap({ data, index, children }: RouteProps) {
  const route = useMemo(() => project(data), [data]);

  if (!route) {
    return null;
  }

  const start = route.points[0];
  const finish = route.points.at(-1);

  const marker =
    index === null
      ? undefined
      : route.points.reduce((best, p) =>
          Math.abs(p.index - index) < Math.abs(best.index - index) ? p : best,
        );

  return (
    <figure className="chart card">
      <figcaption>
        <span>Route, colored by heart rate</span>
      </figcaption>
      <div className="route">
        <svg
          viewBox={`0 0 ${ROUTE.width} ${ROUTE.height}`}
          role="img"
          aria-label="GPS route of this activity"
        >
          {route.runs.map((run, i) => (
            <path
              key={i}
              d={run.d}
              fill="none"
              stroke={HEART_RATE_BINS[run.bin]}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {start && (
            <circle
              className="marker"
              cx={start.x}
              cy={start.y}
              r={6}
              fill="var(--app-bg)"
              stroke="var(--app-text)"
              strokeWidth={2}
            />
          )}
          {finish && (
            <circle className="marker" cx={finish.x} cy={finish.y} r={6} fill="var(--app-text)" />
          )}
          {marker && (
            <circle className="marker" cx={marker.x} cy={marker.y} r={7} fill="var(--series-2)" />
          )}
        </svg>
      </div>
      <ul className="legend">
        <li>
          <span
            className="swatch"
            style={{ background: "var(--app-bg)", border: "2px solid var(--app-text)" }}
          />{" "}
          Start
        </li>
        <li>
          <span className="swatch" style={{ background: "var(--app-text)" }} /> Finish
        </li>
        {route.heartRate && (
          <li>
            {HEART_RATE_BINS.map((color) => (
              <span key={color} className="swatch" style={{ background: color, borderRadius: 0 }} />
            ))}
            {count(route.heartRate.low)}–{count(route.heartRate.high)} bpm
          </li>
        )}
      </ul>
      {children}
    </figure>
  );
}

function Replay({ data, index, onIndex }: ReplayProps) {
  const [playing, setPlaying] = useState(false);
  const last = data.length - 1;

  useEffect(() => {
    if (!playing) {
      return;
    }

    let frame = 0;
    let previous = performance.now();
    let position = index === null || index >= last ? 0 : index;

    const tick = (now: number) => {
      // The whole activity replays in about twelve seconds.
      position = Math.min(last, position + ((now - previous) / 12_000) * last);
      previous = now;
      onIndex(Math.round(position));

      if (position >= last) {
        setPlaying(false);

        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
    // Restart only when play toggles; the loop owns the index while playing.
  }, [playing]);

  const sample = data[index ?? 0];

  return (
    <div className="section">
      <div className="replay">
        <button type="button" className="button primary" onClick={() => setPlaying(!playing)}>
          {playing ? "Pause" : "▶ Replay"}
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={index ?? 0}
          aria-label="Replay position"
          onChange={(event) => {
            setPlaying(false);
            onIndex(Number(event.currentTarget.value));
          }}
        />
      </div>
      {sample && (
        <div className="readout" aria-live="off">
          <div>
            <span className="label">Elapsed</span>
            {clock(sample.t)}
          </div>
          <div>
            <span className="label">Distance</span>
            {kilometers(sample.distance)}
          </div>
          <div>
            <span className="label">Heart rate</span>
            {present(sample.hr) ? `${count(sample.hr)} bpm` : DASH}
          </div>
          <div>
            <span className="label">Pace</span>
            {pace(sample.speed)}
          </div>
        </div>
      )}
    </div>
  );
}

export function ActivityPanel({ data }: PanelProps) {
  const [index, setIndex] = useState<number | null>(null);
  const records = useMemo(() => samples(data.fit?.messages?.recordMesgs ?? []), [data]);
  const session = data.fit?.messages?.sessionMesgs?.[0];
  const laps = data.fit?.messages?.lapMesgs ?? [];
  const sets = data.fit?.sets ?? [];
  const s = data.summary;
  const distance = s?.distanceInMeters ?? session?.totalDistance;
  const duration = s?.durationInSeconds ?? session?.totalTimerTime;
  const speed = s?.averageSpeedInMetersPerSecond ?? session?.enhancedAvgSpeed ?? session?.avgSpeed;
  const heartRate = series(records, (r) => r.hr);
  const elevation = series(records, (r) => r.altitude);
  const speeds = series(records, (r) => (present(r.speed) ? r.speed * 3.6 : null));
  const domain: Domain = [0, records.at(-1)?.t ?? 1];
  const fastestLap = Math.max(1e-9, ...laps.map((l) => l.enhancedAvgSpeed ?? l.avgSpeed ?? 0));

  const chartProps = {
    formatX: clock,
    xDomain: domain,
    xSeconds: true,
    active: index,
    onActive: setIndex,
  };

  const avgHeartRate = s?.averageHeartRateInBeatsPerMinute ?? session?.avgHeartRate;
  const maxHeartRate = s?.maxHeartRateInBeatsPerMinute ?? session?.maxHeartRate;
  const ascent = s?.totalElevationGainInMeters ?? session?.totalAscent;
  const avgSpeed = present(speed) ? speed * 3.6 : null;

  return (
    <>
      <section className="card headline" aria-label="Activity summary">
        <div>
          <span className="label">Distance</span>
          <span className="value">
            {present(distance) ? count(distance / 1000, 2) : DASH}
            {present(distance) && <span className="unit"> km</span>}
          </span>
        </div>
        <div>
          <span className="label">Time</span>
          <span className="value">{clock(duration)}</span>
        </div>
        <div>
          <span className="label">Avg pace</span>
          <span className="value">
            {speed ? clock(1000 / speed) : DASH}
            {speed ? <span className="unit"> /km</span> : null}
          </span>
        </div>
      </section>
      <div className="grid">
        <Stat
          label="Avg heart rate"
          value={count(avgHeartRate)}
          unit="bpm"
          note={`max ${count(maxHeartRate)} bpm`}
        />
        <Stat label="Elevation gain" value={count(ascent)} unit="m" />
        <Stat
          label="Calories"
          value={count(s?.activeKilocalories ?? session?.totalCalories)}
          unit="kcal"
        />
      </div>

      {records.length > 1 && (
        <>
          <RouteMap data={records} index={index}>
            <Replay data={records} index={index} onIndex={setIndex} />
          </RouteMap>
          <LineChart
            label="Heart rate (bpm)"
            summary={
              present(avgHeartRate)
                ? `avg ${count(avgHeartRate)} · max ${count(maxHeartRate)}`
                : undefined
            }
            points={heartRate}
            formatY={(v) => count(v)}
            color="var(--series-2)"
            area
            {...chartProps}
          />
          <LineChart
            label="Speed (km/h)"
            summary={present(avgSpeed) ? `avg ${count(avgSpeed, 1)}` : undefined}
            points={speeds}
            formatY={(v) => count(v, 1)}
            {...chartProps}
          />
          <LineChart
            label="Elevation (m)"
            summary={present(ascent) ? `+${count(ascent)} m` : undefined}
            points={elevation}
            formatY={(v) => count(v)}
            color="var(--series-3)"
            area
            {...chartProps}
          />
        </>
      )}

      {!records.length && (
        <p className="muted">
          {data.fit?.availability && data.fit.availability !== "available"
            ? `FIT samples: ${words(data.fit.availability)}.`
            : "No recorded samples were received for this activity."}
        </p>
      )}

      {laps.length > 1 && (
        <section className="card section">
          <h2>Laps</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lap</th>
                  <th className="num">Distance</th>
                  <th className="num">Time</th>
                  <th className="num">Pace</th>
                  <th className="num">Avg HR</th>
                  <th>
                    <span className="visually-hidden">Relative speed</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {laps.map((l, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="num">{kilometers(l.totalDistance)}</td>
                    <td className="num">{clock(l.totalTimerTime)}</td>
                    <td className="num">{pace(l.enhancedAvgSpeed ?? l.avgSpeed)}</td>
                    <td className="num">{count(l.avgHeartRate)}</td>
                    <td className="bar-cell" aria-hidden="true">
                      <span
                        className="bar"
                        style={{
                          width: `${Math.round(((l.enhancedAvgSpeed ?? l.avgSpeed ?? 0) / fastestLap) * 100)}%`,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sets.length > 0 && (
        <section className="card section">
          <h2>Strength sets</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Exercise</th>
                  <th className="num">Reps</th>
                  <th className="num">Weight</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {sets
                  .filter((set) => set.setType !== "rest")
                  .map((set) => (
                    <tr key={set.index}>
                      <td>{set.index + 1}</td>
                      <td>
                        {words(set.exercises[0]?.name ?? set.exercises[0]?.category ?? "Unknown")}
                      </td>
                      <td className="num">{set.repetitions ?? DASH}</td>
                      <td className="num">
                        {set.weightKg === null ? DASH : `${count(set.weightKg, 1)} kg`}
                      </td>
                      <td className="num">{clock(set.durationSeconds)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function activityTitle(data: ActivityData): string {
  return (
    data.summary?.activityName ??
    (data.summary?.activityType ? words(data.summary.activityType) : `Activity ${data.activityId}`)
  );
}

export function ActivityView({ tool }: ViewProps) {
  const loaded = readResult(tool.result, activityData);

  if (loaded.state !== "ready") {
    return <Status loaded={loaded} what="activity" />;
  }

  if (!loaded.data) {
    return <p className="muted">This activity has not been received from Garmin.</p>;
  }

  return (
    <>
      <header className="header">
        <h1>
          <span className="eyebrow">
            Garmin activity
            {loaded.data.summary?.deviceName ? ` · ${loaded.data.summary.deviceName}` : ""}
          </span>
          {activityTitle(loaded.data)}
        </h1>
      </header>
      <ActivityPanel data={loaded.data} />
    </>
  );
}
