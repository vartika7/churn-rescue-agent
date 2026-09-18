"use client";

import { useCallback, useId, useMemo, useState } from "react";

import { formatDate } from "@/lib/format";
import type { UsageDaily } from "@/lib/types";

/* The SVG is drawn in a fixed viewBox and scaled by CSS (width:100%,
   height:auto), so hover maps a pointer position onto a data index by ratio
   rather than by pixel. Text lives in HTML siblings instead of inside the SVG
   so it does not shrink with the viewport on narrow screens. */
const VB_W = 1000;
const VB_H = 260;
const PAD_T = 14;
const PAD_B = 14;

interface Point {
  x: number;
  y: number;
  row: UsageDaily;
}

export function UsageChart({ data }: { data: UsageDaily[] }) {
  const gradientId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const sorted = useMemo(
    () => [...data].sort((a, b) => a.date.localeCompare(b.date)),
    [data],
  );

  const { points, maxSessions, linePath, areaPath } = useMemo(() => {
    const n = sorted.length;
    if (n === 0) {
      return {
        points: [] as Point[],
        maxSessions: 0,
        linePath: "",
        areaPath: "",
      };
    }

    const max = Math.max(...sorted.map((d) => d.sessions), 1);
    const plotH = VB_H - PAD_T - PAD_B;

    const pts: Point[] = sorted.map((row, i) => ({
      x: n === 1 ? VB_W / 2 : (i / (n - 1)) * VB_W,
      y: PAD_T + plotH - (row.sessions / max) * plotH,
      row,
    }));

    const line = pts
      .map(
        (p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
      )
      .join(" ");

    const area =
      `${line} L${pts[pts.length - 1].x.toFixed(2)} ${VB_H} ` +
      `L${pts[0].x.toFixed(2)} ${VB_H} Z`;

    return { points: pts, maxSessions: max, linePath: line, areaPath: area };
  }, [sorted]);

  const indexFromClientX = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || points.length === 0) return null;
      const ratio = (clientX - rect.left) / rect.width;
      const index = Math.round(ratio * (points.length - 1));
      return Math.min(points.length - 1, Math.max(0, index));
    },
    [points.length],
  );

  if (points.length === 0) {
    return (
      <p className="evidence-empty">
        No usage history on record for this customer.
      </p>
    );
  }

  const active = activeIndex === null ? null : points[activeIndex];
  const activePct = active ? (active.x / VB_W) * 100 : 0;

  // Keep the tooltip inside the chart at both ends instead of letting it clip.
  const tooltipShift =
    activePct < 16
      ? "translateX(0)"
      : activePct > 84
        ? "translateX(-100%)"
        : "translateX(-50%)";

  const axisTicks = pickAxisTicks(sorted);

  return (
    <div className="chart-shell">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        style={{ aspectRatio: `${VB_W} / ${VB_H}` }}
        role="img"
        aria-label={`Daily sessions from ${formatDate(sorted[0].date)} to ${formatDate(
          sorted[sorted.length - 1].date,
        )}. Peak ${maxSessions} sessions.`}
        onMouseMove={(event) => {
          setActiveIndex(indexFromClientX(event.clientX, event.currentTarget));
        }}
        onMouseLeave={() => setActiveIndex(null)}
        onTouchStart={(event) => {
          setActiveIndex(
            indexFromClientX(event.touches[0].clientX, event.currentTarget),
          );
        }}
        onTouchMove={(event) => {
          setActiveIndex(
            indexFromClientX(event.touches[0].clientX, event.currentTarget),
          );
        }}
        onTouchEnd={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--link)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--link)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal guides at quarters of the peak. */}
        {[0.25, 0.5, 0.75].map((fraction) => {
          const y = PAD_T + (VB_H - PAD_T - PAD_B) * (1 - fraction);
          return (
            <line
              key={fraction}
              x1="0"
              x2={VB_W}
              y1={y}
              y2={y}
              stroke="var(--border-soft)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--link)"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active && (
          <g pointerEvents="none">
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD_T}
              y2={VB_H - PAD_B}
              stroke="var(--text-faint)"
              strokeWidth="1"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            {/* preserveAspectRatio="none" makes the drawing fill the box exactly,
                which is what keeps the hover maths above correct — but it also
                means any divergence between the CSS box and the viewBox ratio
                would squash a circle into an ellipse. A cross of two rects stays
                readable either way. */}
            <rect
              x={active.x - 4}
              y={active.y - 1.05}
              width={8}
              height={2.1}
              fill="var(--text)"
            />
            <rect
              x={active.x - 1}
              y={active.y - 4.2}
              width={2}
              height={8.4}
              fill="var(--text)"
            />
          </g>
        )}
      </svg>

      <span className="chart-yhint mono">peak {maxSessions} sessions/day</span>

      {active && (
        <div
          className="chart-tooltip"
          style={{ left: `${activePct}%`, transform: tooltipShift }}
        >
          <div className="chart-tooltip-date">
            {formatDate(active.row.date)}
          </div>
          <div className="chart-tooltip-row">
            <span>Sessions</span>
            <span className="mono">{formatMetric(active.row.sessions)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span>Logins</span>
            <span className="mono">{formatMetric(active.row.logins)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span>Key actions</span>
            <span className="mono">{formatMetric(active.row.key_actions)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span>Feature usage</span>
            <span className="mono">
              {formatMetric(active.row.feature_usage)}
            </span>
          </div>
        </div>
      )}

      <div className="chart-axis mono">
        {axisTicks.map((tick) => (
          <span key={tick}>{formatDate(tick)}</span>
        ))}
      </div>

      <div className="chart-legend">
        <span>
          {sorted.length} observed days · {formatDate(sorted[0].date)} →{" "}
          {formatDate(sorted[sorted.length - 1].date)}
        </span>
        <span>Hover or drag across the chart for a day&apos;s detail</span>
      </div>
    </div>
  );
}

/** Four evenly spaced dates, first and last always included. */
function pickAxisTicks(rows: UsageDaily[]): string[] {
  if (rows.length <= 4) return rows.map((r) => r.date);
  const count = 4;
  return Array.from(
    { length: count },
    (_, i) => rows[Math.round((i / (count - 1)) * (rows.length - 1))].date,
  );
}

/**
 * All four metrics are integer columns, so the numeric branch is what runs.
 * The fallbacks exist so a schema change renders something readable instead of
 * "NaN" in the tooltip.
 */
function formatMetric(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US");
  }
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}
