import type { WorldTransform } from "../../coords/transforms.js";
import type { ResolvedStyle } from "../types.js";
import type { ApplyOutcome } from "./apply-types.js";
import { type ColorAliasResolver } from "./colors.js";
export declare function applyFlagEntry(key: string, raw: string, style: ResolvedStyle, transform: WorldTransform, resolveColorAlias?: ColorAliasResolver): ApplyOutcome;
