const lengthPattern = /^(\d+(?:\.\d+)?|\.\d+)(ch|px|em|rem|lh)$/i;
const trackPattern = /^(\d+(?:\.\d+)?|\.\d+)(fr|ch|%)$/i;
const alignment = new Map([["start", "start"], ["center", "center"], ["end", "end"], ["between", "space-between"], ["around", "space-around"]]);
const vertical = new Map([["start", "top"], ["center", "center"], ["end", "bottom"], ["stretch", "stretch"]]);
const gapSizes = new Map([["sm", 1], ["md", 2], ["lg", 3]]);

function readLength(source) {
  if (source === "0") return { value: 0, unit: "px" };
  const match = lengthPattern.exec(source || "");
  const value = Number(match?.[1]);
  if (!match || value > 1000) return null;
  return { value, unit: match[2].toLowerCase() };
}

function readTracks(source) {
  if (!source) return null;
  const tracks = source.trim().split(/\s+/u).map((part) => {
    const match = trackPattern.exec(part);
    const value = Number(match?.[1]);
    return match && value > 0 && value <= 1000 ? { value, unit: match[2].toLowerCase() } : null;
  });
  return tracks.length >= 2 && tracks.length <= 6 && tracks.every(Boolean) ? tracks : null;
}

export function parseAdaptiveColumns(attrs) {
  const requested = Number(attrs.columns ?? attrs.cols);
  const maxColumns = Number.isInteger(requested) && requested >= 1 && requested <= 6 ? requested : 6;
  const tracks = readTracks(attrs.tracks || attrs.columns);
  const gap = readLength(attrs.gap);
  const minimum = readLength(attrs["min-width"]);
  const padding = readLength(attrs.padding);
  const horizontal = alignment.get(attrs["justify-content"]) || alignment.get(attrs["align-self"]);
  const align = vertical.get(attrs["align-items"]) || null;
  const wrapping = /^(true|on|yes|1)$/i.test(attrs.wrap || "");
  const counted = attrs.columns && Number.isInteger(requested) && requested >= 1 && requested <= 6;
  if (!tracks && !gap && !minimum && !padding && !horizontal && !align && !counted && !wrapping) return null;
  const namedGap = gapSizes.get(attrs.gap) || 2;
  return { tracks, maxColumns, minimum: minimum || { value: 24, unit: "ch" },
    gap: gap || { value: namedGap, unit: "ch" }, padding: padding || { value: 0, unit: "px" },
    justify: horizontal || "start", align, wrap: wrapping || !tracks };
}

export function columnPaneGrow(value) {
  const grow = Number(value);
  return Number.isFinite(grow) && grow > 0 && grow <= 1000 ? grow : 1;
}

/** Solve source-ordered track widths using the container's actual inline metrics. */
export function layoutAdaptiveColumns(spec, growth, metrics) {
  const length = ({ value, unit }) => value * (unit === "px" ? 1 : metrics[unit]);
  const width = Math.max(0, metrics.width);
  const minimum = length(spec.minimum);
  const fullPadding = Math.min(length(spec.padding), width / 4);
  const fullGap = length(spec.gap);
  const requested = growth.map((grow, index) => {
    const track = spec.tracks?.[index] || { value: 1, unit: "fr" };
    return track.unit === "fr" ? { value: track.value * grow, unit: "fr" } : track;
  });
  const rowsFor = (padding, gap) => {
    const inner = width - 2 * padding;
    const fit = (tracks) => {
      const budget = inner - gap * (tracks.length - 1);
      const fixedWidths = tracks.map(({ unit, value }) => unit === "ch" ? value * metrics.ch : unit === "%" ? value * budget / 100 : 0);
      const space = budget - fixedWidths.reduce((total, item) => total + item, 0);
      const weight = tracks.reduce((sum, track) => sum + (track.unit === "fr" ? track.value : 0), 0);
      const result = tracks.map((track, index) => track.unit === "fr" ? space * track.value / weight : fixedWidths[index]);
      return space >= -0.001 && result.every((item) => item >= minimum - 0.001) ? result : null;
    };
    if (requested.length <= spec.maxColumns) {
      const singleRow = fit(requested);
      if (singleRow) return [singleRow];
    }
    if (!spec.wrap) return requested.map(() => [inner]);
    const rows = [];
    for (let index = 0; index < requested.length;) {
      let count = Math.min(spec.maxColumns, requested.length - index);
      let row = null;
      while (count >= 1 && !row) {
        row = fit(requested.slice(index, index + count));
        if (!row) count--;
      }
      rows.push(row || [inner]);
      index += Math.max(1, count);
    }
    return rows;
  };
  if (!requested.length) return { rows: [], gap: fullGap, padding: fullPadding };
  const rows = rowsFor(fullPadding, fullGap);
  if (rows.length <= 1) return { rows, gap: fullGap, padding: fullPadding };
  const compactPadding = Math.min(fullPadding, metrics.ch);
  const compactGap = Math.min(fullGap, metrics.ch);
  return { rows: rowsFor(compactPadding, compactGap), gap: compactGap, padding: compactPadding };
}
