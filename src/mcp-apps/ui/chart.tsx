/** @jsxImportSource react */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { DASH, type Measure } from "./format";

export type Point = { x: number; y: number };

type LineChartProps = {
  label: string;
  points: Point[];
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  /** CSS color token for the single series. */
  color?: string;
  area?: boolean;
  xDomain?: [number, number];
  /** The x values are seconds; ticks land on clock-friendly steps. */
  xSeconds?: boolean;
  /** Shared hover index, so one chart can drive another view (the activity route marker). */
  active?: number | null;
  onActive?: (index: number | null) => void;
};

const HEIGHT = 150;
const PAD = { top: 10, right: 10, bottom: 22, left: 40 };

export function niceTicks(min: number, max: number, count = 3): number[] {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const ticks: number[] = [];

  for (let tick = Math.ceil(min / nice) * nice; tick <= max + 1e-9; tick += nice) {
    ticks.push(Number(tick.toFixed(6)));
  }

  return ticks;
}

const SECOND_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200];

/** Ticks for a seconds axis: whole minutes or hours, at most five. */
export function secondTicks(min: number, max: number): number[] {
  const step = SECOND_STEPS.find((s) => (max - min) / s <= 4) ?? 86_400;
  const ticks: number[] = [];

  for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) {
    ticks.push(tick);
  }

  return ticks;
}

/** Track the rendered width so tick labels stay legible instead of scaling with the SVG. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(Math.max(240, Math.round(entry.contentRect.width)));
      }
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/** The point nearest an x value; points are sorted by x. */
function nearest(points: Point[], x: number): number {
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = (low + high) >> 1;

    if ((points[mid]?.x ?? 0) < x) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const before = points[low - 1];

  return before && x - before.x < (points[low]?.x ?? x) - x ? low - 1 : low;
}

/** One series, one axis: 2px line, hairline grid, crosshair + tooltip on hover. */
export function LineChart(props: LineChartProps) {
  const { points, formatX, formatY, color = "var(--series-1)" } = props;
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: WIDTH } = useWidth(640);

  if (points.length < 2) {
    return null;
  }

  let yMin = Infinity;
  let yMax = -Infinity;

  for (const p of points) {
    yMin = Math.min(yMin, p.y);
    yMax = Math.max(yMax, p.y);
  }

  const [x0, x1] = props.xDomain ?? [points[0]?.x ?? 0, points.at(-1)?.x ?? 1];
  const yTicks = niceTicks(yMin, yMax);
  const y0 = Math.min(yMin, yTicks[0] ?? yMin);
  const y1 = Math.max(yMax, yTicks.at(-1) ?? yMax);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const baseline = HEIGHT - PAD.bottom;
  const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0 || 1)) * plotWidth;
  const sy = (y: number) => baseline - ((y - y0) / (y1 - y0 || 1)) * (baseline - PAD.top);

  const line = points
    .map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join("");

  const shown = props.active ?? hover;
  const point = shown === null ? undefined : points[shown];

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - box.left) / box.width) * WIDTH;
    const index = nearest(points, x0 + ((svgX - PAD.left) / plotWidth) * (x1 - x0));
    setHover(index);
    props.onActive?.(index);
  };

  const leave = () => {
    setHover(null);
    props.onActive?.(null);
  };

  return (
    <figure className="chart">
      <figcaption>{props.label}</figcaption>
      <div className="chart-frame" ref={ref}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${props.label}, ${formatY(yMin)} to ${formatY(yMax)}`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={leave}
        >
          {yTicks.map((tick) => (
            <g key={`y${tick}`}>
              <line
                className="grid-line"
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={sy(tick)}
                y2={sy(tick)}
              />
              <text className="tick" x={PAD.left - 6} y={sy(tick) + 4} textAnchor="end">
                {formatY(tick)}
              </text>
            </g>
          ))}
          {(props.xSeconds ? secondTicks(x0, x1) : niceTicks(x0, x1, 4)).map((tick) => (
            <text key={`x${tick}`} className="tick" x={sx(tick)} y={HEIGHT - 6} textAnchor="middle">
              {formatX(tick)}
            </text>
          ))}
          <line
            className="axis-line"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={baseline}
            y2={baseline}
          />
          {props.area && (
            <path
              d={`${line}L${sx(points.at(-1)?.x ?? x1)},${baseline}L${sx(points[0]?.x ?? x0)},${baseline}Z`}
              fill={color}
              opacity={0.1}
            />
          )}
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {point && (
            <g>
              <line
                className="crosshair"
                x1={sx(point.x)}
                x2={sx(point.x)}
                y1={PAD.top}
                y2={baseline}
              />
              <circle className="marker" cx={sx(point.x)} cy={sy(point.y)} r={5} fill={color} />
            </g>
          )}
        </svg>
        {point && (
          <div
            className="tooltip"
            style={{ left: `${Math.min(88, Math.max(12, (sx(point.x) / WIDTH) * 100))}%` }}
          >
            <strong>{formatY(point.y)}</strong> · {formatX(point.x)}
          </div>
        )}
      </div>
    </figure>
  );
}

type RingProps = { label: string; value: Measure; goal: Measure; display: string };

/** Goal progress: series fill on a lighter step of the same hue; over-goal caps at a full ring. */
export function Ring({ label, value, goal, display }: RingProps) {
  const fraction = value !== undefined && value !== null && goal ? Math.min(1, value / goal) : 0;
  const circumference = 2 * Math.PI * 34;

  return (
    <div className="ring-tile">
      <svg viewBox="0 0 84 84" aria-hidden="true">
        <circle cx={42} cy={42} r={34} className="ring-track" />
        {fraction > 0 && (
          <circle
            cx={42}
            cy={42}
            r={34}
            className="ring-fill"
            strokeDasharray={`${fraction * circumference} ${circumference}`}
            transform="rotate(-90 42 42)"
          />
        )}
        <text x={42} y={47} textAnchor="middle" className="ring-percent">
          {goal && value !== undefined && value !== null
            ? `${Math.round((value / goal) * 100)}%`
            : DASH}
        </text>
      </svg>
      <div>
        <div className="label">{label}</div>
        <div className="value">{display}</div>
      </div>
    </div>
  );
}

type StatProps = { label: string; value: string; note?: string | undefined };

export function Stat({ label, value, note }: StatProps) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export type Part = { label: string; value: number; color: string };

/** One whole split into parts: 2px surface gaps, legend always present, values in the legend. */
type SegmentedBarProps = { label: string; parts: Part[]; format: (v: number) => string };

export function SegmentedBar({ label, parts, format }: SegmentedBarProps) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);

  if (!total) {
    return null;
  }

  return (
    <div className="section">
      <div
        className="segmented"
        role="img"
        aria-label={`${label}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`}
      >
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <span
              key={part.label}
              title={`${part.label}: ${format(part.value)}`}
              style={{ flexGrow: part.value, background: part.color }}
            />
          ))}
      </div>
      <ul className="legend">
        {parts.map((part) => (
          <li key={part.label}>
            <span className="swatch" style={{ background: part.color }} />
            {part.label} · {format(part.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
