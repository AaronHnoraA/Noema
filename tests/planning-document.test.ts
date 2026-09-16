import {describe,expect,test} from '@voidzero-dev/vite-plus-test';
import fixtures from '../shared/planning-document-fixtures.json';
import {scanPlanningDocument} from '../shared/planning-document.mjs';
import {applyPlanningSourceMutation} from '../shared/planning-mutation.mjs';
import {EditorState} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {ensureSyntaxTree} from '@codemirror/language';
import {scanCodeRanges} from '../src/cm6/code-ranges.ts';

describe('document-aware native planning',()=>{
  for(const fixture of fixtures)test(fixture.name,()=>{
    const nodes=scanPlanningDocument(fixture.input);
    expect(nodes.map(node=>node.raw)).toEqual(fixture.expected);
    for(const node of nodes){
      expect(fixture.input.slice(node.span.from,node.span.to)).toBe(node.raw);
      expect(node.span.from).toBe(fixture.input.indexOf(node.raw));
    }
    // The same source must remain ordinary code in the editor's actual tree.
    const state=EditorState.create({doc:fixture.input,extensions:[markdown()]});
    ensureSyntaxTree(state,state.doc.length,1000);
    const code=scanCodeRanges(state,[{from:0,to:state.doc.length}]);
    for(const node of nodes)expect(code.some(range=>range.from<=node.span.from&&node.span.from<range.to)).toBe(false);
  });

  test('capture cannot append a task inside an unclosed fence',()=>{
    expect(applyPlanningSourceMutation('```md\nExample',{},
      {type:'append',source:'@@todo [Captured]{id: capture}'})).toBeNull();
  });

  test('an edit cannot turn a live task into an inline code example',()=>{
    const source='` @@todo [Live]{id: live}';
    expect(applyPlanningSourceMutation(source,{id:'live'},
      {type:'replace',source:'@@todo [Live `]{id: live}'})).toBeNull();
  });

  test('stale selectors cannot edit a task that moved into a code fence',()=>{
    const task='@@todo [Example]{id: example}',source=`\`\`\`md\n${task}\n\`\`\`\n`;
    expect(applyPlanningSourceMutation(source,{kind:'todo',id:'example',index:source.indexOf(task),source:task},
      {type:'replace',source:'@@todo(done) [Example]{id: example}'})).toBeNull();
  });
});
