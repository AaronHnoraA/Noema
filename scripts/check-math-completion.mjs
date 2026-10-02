// Exercises the real app's popup handlers in WebKit, with an inert host bridge.
// Test-only exports are appended to Vite's transformed module; no probe is
// exposed by the production renderer. No user's notes are opened or saved.
import {fileURLToPath} from 'node:url';
const {webkit}=await import(process.env.NOEMA_PLAYWRIGHT_MODULE || 'playwright');
import {createServer} from 'vite';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('../',import.meta.url));
const server=await createServer({configFile:repo+'/vite.aaronnote.config.ts',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
await server.listen();
const browser=await webkit.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1600,height:800}});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.addInitScript(()=>{window.aaronnoteApi={copilot:{request:async()=>({ok:true})},notes:{bootstrap:()=>new Promise(()=>{})},config:{katexMacros:async()=>({macros:{}})}};});
 await page.route('**/main.ts',async route=>{const response=await route.fetch();let body=await response.text();body+=`\nwindow.popupProbe={
  setup(){ paused=false;host.hidden=false;editor.setMarkdown('\\\\(x^2 + \\\\frac{1}{2}\\\\)');editor.setMarkdownSelection(5); },
  preview(anchor){const doc=editor.view.state.doc;const tex='x^2 + \\\\frac{1}{2}';updateMathPreview(editor.cursorContext(),true,{tex,display:false,from:0,to:doc.length,contentFrom:2,contentTo:doc.length-2,doc,geometryEpoch:0,selection:{anchor:3,head:3},rect:anchor,rectEnd:anchor});},
  menu(rect){showSnippetPopup('fr',[{key:'frac',name:'Fraction',body:'\\\\frac{a}{b}',mode:'tex-mode',group:'math'},{key:'frakg',name:'Fraktur',body:'g',mode:'tex-mode',group:'math'}],2,rect);},
  hideMenu:hideSnippetPopup,
  state(){return {previewHidden:mathPreview.hidden,visibility:mathPreview.style.visibility,session:!!mathPreviewSession,preview:mathPreview.getBoundingClientRect().toJSON(),menu:snippetPopup.getBoundingClientRect().toJSON(),menuHidden:snippetPopup.hidden};}
};`;await route.fulfill({response,body});});
 await page.goto(server.resolvedUrls.local[0]);
 await page.waitForFunction(()=>!!window.popupProbe);
 await page.evaluate(()=>popupProbe.setup());
 await page.waitForTimeout(300);
 await page.evaluate(()=>{popupProbe.menu({left:1100,top:170,bottom:190});popupProbe.preview({left:300,top:170,bottom:190});});
 await page.waitForTimeout(600);
 const separate=await page.evaluate(()=>popupProbe.state()); console.log('separate',separate); assert.equal(separate.previewHidden,false);assert.equal(separate.menuHidden,false);assert.equal(separate.visibility,'');assert.ok(separate.preview.right<separate.menu.left);
 await page.evaluate(()=>{popupProbe.hideMenu();popupProbe.preview({left:300,top:170,bottom:190});popupProbe.menu({left:1100,top:170,bottom:190});});
 const reopened=await page.evaluate(()=>popupProbe.state());assert.equal(reopened.previewHidden,false);assert.equal(reopened.visibility,'');assert.equal(reopened.session,true);
 await page.evaluate(()=>{popupProbe.menu({left:300,top:30,bottom:50});popupProbe.preview({left:300,top:30,bottom:50});});
 await page.waitForTimeout(200);
 const collision=await page.evaluate(()=>popupProbe.state());console.log('collision',collision);assert.equal(collision.visibility,'');assert.ok(collision.preview.top>=collision.menu.bottom || collision.preview.right<=collision.menu.left || collision.preview.left>=collision.menu.right || collision.preview.bottom<=collision.menu.top);
 await page.evaluate(()=>popupProbe.hideMenu());
 console.log('closed',await page.evaluate(()=>popupProbe.state()));
 await page.setViewportSize({width:400,height:220});await page.waitForTimeout(200);
 await page.evaluate(()=>{popupProbe.menu({left:8,top:30,bottom:50});popupProbe.preview({left:8,top:30,bottom:50});});await page.waitForTimeout(200);
 const small=await page.evaluate(()=>popupProbe.state());console.log('no-space',small);assert.equal(small.visibility,'hidden');assert.equal(small.session,true);assert.equal(small.menuHidden,false);
 await page.evaluate(()=>popupProbe.hideMenu());const restored=await page.evaluate(()=>popupProbe.state());assert.equal(restored.visibility,'');assert.equal(restored.previewHidden,false);assert.equal(restored.session,true);
} finally {await browser.close();await server.close();}
