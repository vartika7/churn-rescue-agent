const WIDTH = 108;
const HEIGHT = 26;
const PAD = 2;

/**
 * Static 90-day sessions sparkline for the dashboard table.
 *
 * Intentionally a single neutral colour: colouring it by slope would read as a
 * risk judgement, and the only risk signal in this build is the clearly
 * labelled placeholder badge. The numeric delta sits beside it instead.
 */
export function Sparkline({
  values,
  label,
}: {
  values: number[];
  label?: string;
}) {
  if (values.length === 0) {
    return <span className="cell-sub">no data</span>;
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const plotW = WIDTH - PAD * 2;
  const plotH = HEIGHT - PAD * 2;

  const x = (i: number) =>
    values.length === 1
      ? PAD + plotW / 2
      : PAD + (i / (values.length - 1)) * plotW;
  const y = (v: number) => PAD + plotH - ((v - min) / span) * plotH;

  const line = values
    .map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label ?? `Sessions trend over the last ${values.length} days`}
      style={{ display: "block", flex: "none" }}
    >
      <polyline
        points={line}
        fill="none"
        stroke="var(--text-dim)"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
