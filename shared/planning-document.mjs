import {parser} from '@lezer/markdown';
import {orgMetaSummaryRange} from './meta-summary.mjs';
import {scanPlanningNodes} from './planning-dsl.mjs';

const codeNodes=new Set(['FencedCode','CodeBlock','InlineCode']);

/** Source eligibility uses the editor's Markdown parser, not a fence regexp.
 * Only command starts are excluded: code within a real task title remains
 * part of that title. No text is rewritten, so UTF-16 spans stay source-exact. */
export function planningDocumentExcludedRanges(input) {
  const source=String(input||''),ranges=[];
  parser.parse(source).iterate({enter(node){
    if(codeNodes.has(node.name)){ranges.push({from:node.from,to:node.to});return false;}
  }});
  const summary=orgMetaSummaryRange(source,{isExcluded:offset=>ranges.some(range=>range.from<=offset&&offset<range.to)});
  if(summary)ranges.push(summary);
  ranges.sort((a,b)=>a.from-b.from||a.to-b.to);
  const merged=[];
  for(const range of ranges){
    const previous=merged.at(-1);
    if(previous&&range.from<=previous.to)previous.to=Math.max(previous.to,range.to);
    else merged.push({from:range.from,to:range.to});
  }
  return merged;
}

export function scanPlanningDocument(input,options={}) {
  const source=String(input||'');
  if(!source.includes('@@'))return [];
  return scanPlanningNodes(source,{...options,excludedRanges:planningDocumentExcludedRanges(source)});
}

/** Validate the edited region against its surrounding Markdown before saving. */
export function planningSourceIsLive(content,from,source) {
  const proposed=scanPlanningNodes(source);
  if(!proposed.length)return true;
  const nodes=scanPlanningDocument(content);
  return proposed.every(candidate=>nodes.some(node=>node.span.from===from+candidate.span.from&&node.raw===candidate.raw));
}
