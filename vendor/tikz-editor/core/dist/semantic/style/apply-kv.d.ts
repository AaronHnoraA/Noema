import type { WorldPoint } from "../../coords/points.js";
import type { WorldTransform } from "../../coords/transforms.js";
import { type ResolvedStyle } from "../types.js";
import type { ApplyEntryFn, ApplyOutcome } from "./apply-types.js";
import { type ColorAliasResolver } from "./colors.js";
export declare function applyKvEntry(key: string, valueRaw: string, style: ResolvedStyle, transform: WorldTransform, applyOptionEntry: ApplyEntryFn, resolveCoordinate?: (raw: string) => WorldPoint | null, resolveColorAlias?: ColorAliasResolver): ApplyOutcome;
