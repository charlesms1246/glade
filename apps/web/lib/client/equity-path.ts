export interface SeriesPoint {
  at: string;
  equityUsd: string;
  floorUsd: string | null;
}

/** SVG paths for equity and (where present) the Floor target, scaled to a W×H box with a little headroom. */
export function equityPaths(points: readonly SeriesPoint[], W: number, H: number) {
  if (points.length < 2) return null;
  const t0 = Date.parse(points[0]!.at);
  const span = Math.max(1, Date.parse(points.at(-1)!.at) - t0);
  const values = points.flatMap((p) => [Number(p.equityUsd), ...(p.floorUsd === null ? [] : [Number(p.floorUsd)])]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.1, hi * 0.002, 1);
  const min = lo - pad;
  const max = hi + pad;
  const x = (p: SeriesPoint) => ((Date.parse(p.at) - t0) / span) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;
  const line = (sel: (p: SeriesPoint) => string | null) => {
    let d = "";
    let pen = false;
    for (const p of points) {
      const v = sel(p);
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p).toFixed(1)},${y(Number(v)).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  return { equity: line((p) => p.equityUsd), floor: line((p) => p.floorUsd), min, max };
}
