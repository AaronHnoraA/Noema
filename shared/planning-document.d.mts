import type {PlanningNode} from './planning-dsl.mjs';
export function planningDocumentExcludedRanges(input:string):Array<{from:number;to:number}>;
export function scanPlanningDocument(input:string,options?:{kind?:string}):PlanningNode[];
export function planningSourceIsLive(content:string,from:number,source:string):boolean;
