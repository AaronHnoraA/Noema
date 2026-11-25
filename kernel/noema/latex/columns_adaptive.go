package latex

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type columnLength struct {
	value float64
	unit  string
}

type adaptiveColumns struct {
	tracks  []columnLength
	count   int
	minimum columnLength
	gap     columnLength
	padding columnLength
	align   string
	wrap    bool
}

var columnLengthPattern = regexp.MustCompile("(?i)^(\\d+(?:\\.\\d+)?|\\.\\d+)(ch|px|em|rem|lh)$")
var columnTrackPattern = regexp.MustCompile("(?i)^(\\d+(?:\\.\\d+)?|\\.\\d+)(fr|ch|%)$")

func parseColumnLength(raw string, pattern *regexp.Regexp) (columnLength, bool) {
	match := pattern.FindStringSubmatch(raw)
	if match == nil {
		return columnLength{}, false
	}
	value, err := strconv.ParseFloat(match[1], 64)
	if err != nil || value > 1000 {
		return columnLength{}, false
	}
	return columnLength{value, strings.ToLower(match[2])}, true
}

func adaptiveLength(raw string) (columnLength, bool) {
	if raw == "0" {
		return columnLength{0, "px"}, true
	}
	return parseColumnLength(raw, columnLengthPattern)
}

func adaptiveWrap(raw string) bool {
	switch strings.ToLower(raw) {
	case "true", "on", "yes", "1":
		return true
	}
	return false
}

func parseAdaptiveColumns(attrs map[string]string) *adaptiveColumns {
	spec := &adaptiveColumns{count: 6}
	rawCount := attrs["columns"]
	if rawCount == "" {
		rawCount = attrs["cols"]
	}
	count, err := strconv.Atoi(rawCount)
	counted := err == nil && count >= 1 && count <= 6
	if counted {
		spec.count = count
	}
	rawTracks := attrs["tracks"]
	if rawTracks == "" {
		rawTracks = attrs["columns"]
	}
	parts := strings.Fields(rawTracks)
	if len(parts) >= 2 && len(parts) <= 6 {
		for _, part := range parts {
			track, valid := parseColumnLength(part, columnTrackPattern)
			if !valid || track.value <= 0 {
				spec.tracks = nil
				break
			}
			spec.tracks = append(spec.tracks, track)
		}
	}
	gap, hasGap := adaptiveLength(attrs["gap"])
	minimum, hasMinimum := adaptiveLength(attrs["min-width"])
	padding, hasPadding := adaptiveLength(attrs["padding"])
	spec.align = map[string]string{"start": "top", "center": "center", "end": "bottom", "stretch": "stretch"}[attrs["align-items"]]
	horizontal := map[string]bool{"start": true, "center": true, "end": true, "between": true, "around": true}
	spec.wrap = adaptiveWrap(attrs["wrap"])
	if len(spec.tracks) == 0 && !hasGap && !hasMinimum && !hasPadding && spec.align == "" &&
		!(counted && attrs["columns"] != "") && !spec.wrap &&
		!horizontal[attrs["justify-content"]] && !horizontal[attrs["align-self"]] {
		return nil
	}
	if !hasGap {
		chars, ok := map[string]float64{"sm": 1, "md": 2, "lg": 3}[attrs["gap"]]
		if !ok {
			chars = 2
		}
		gap = columnLength{chars, "ch"}
	}
	if !hasMinimum {
		minimum = columnLength{24, "ch"}
	}
	spec.gap, spec.minimum, spec.padding = gap, minimum, padding
	spec.wrap = spec.wrap || len(spec.tracks) == 0
	return spec
}

func readColumnGrow(raw string) float64 {
	value, err := strconv.ParseFloat(raw, 64)
	if err == nil && value > 0 && value <= 1000 {
		return value
	}
	return 1
}

// Rows are planned against a nominal 80-character line, matching the Node
// transform. The resulting row widths are emitted relative to the TeX measure.
func adaptivePrintRows(spec *adaptiveColumns, panes []columnPane) [][]float64 {
	units := map[string]float64{"px": 1, "ch": 8, "em": 16, "rem": 16, "lh": 24}
	length := func(value columnLength) float64 { return value.value * units[value.unit] }
	tracks := make([]columnLength, len(panes))
	for i, pane := range panes {
		track := columnLength{1, "fr"}
		if i < len(spec.tracks) {
			track = spec.tracks[i]
		}
		if track.unit == "fr" {
			if pane.Grow > 0 {
				track.value *= pane.Grow
			}
		}
		tracks[i] = track
	}
	minimum := length(spec.minimum)
	rowsFor := func(padding, gap float64) [][]float64 {
		inner := 640 - 2*padding
		fit := func(slots []columnLength) []float64 {
			budget := inner - gap*float64(len(slots)-1)
			widths := make([]float64, len(slots))
			remaining, weight := budget, 0.0
			for i, track := range slots {
				switch track.unit {
				case "ch":
					widths[i] = length(track)
				case "%":
					widths[i] = track.value * budget / 100
				case "fr":
					weight += track.value
				}
				remaining -= widths[i]
			}
			if remaining < -0.001 {
				return nil
			}
			for i, track := range slots {
				if track.unit == "fr" {
					widths[i] = remaining * track.value / weight
				}
				if widths[i] < minimum-0.001 {
					return nil
				}
			}
			return widths
		}
		if len(tracks) <= spec.count {
			if single := fit(tracks); single != nil {
				return [][]float64{single}
			}
		}
		var rows [][]float64
		for i := 0; i < len(tracks); {
			count := min(spec.count, len(tracks)-i)
			var row []float64
			if spec.wrap {
				for count >= 1 {
					if row = fit(tracks[i : i+count]); row != nil {
						break
					}
					count--
				}
			}
			if row == nil {
				row, count = []float64{inner}, 1
			}
			rows = append(rows, row)
			i += count
		}
		return rows
	}
	padding, gap := math.Min(length(spec.padding), 160), length(spec.gap)
	rows := rowsFor(padding, gap)
	if len(rows) > 1 {
		rows = rowsFor(math.Min(padding, 8), math.Min(gap, 8))
	}
	return rows
}
