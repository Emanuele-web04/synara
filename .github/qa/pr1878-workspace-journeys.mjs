import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
const root=resolve(process.env.QA_REPO ?? process.cwd());
const out=resolve(process.env.QA_OUT);
await mkdir(out,{recursive:true});
const require=createRequire(join(root,'apps/web/package.json'));
const {chromium,expect}=require('playwright/test');
const temp=await mkdtemp(join(tmpdir(),'synara-pr1878-files-'));
const home=join(temp,'home'), project=join(temp,'project');
await mkdir(home); await mkdir(project);
execFileSync('git',['init','--initial-branch=main',project]);
await writeFile(join(project,'README.md'),'# Workspace acceptance\n\nNeedle one.\n\nNeedle two.\n\n```mermaid\ngraph LR\n A[Read] --> B[Verify]\n```\n');
await writeFile(join(project,'sample.ts'),'export const message = "Original disk content";\n');
await writeFile(join(project,'unicodé-文件.txt'),'Unicode file content\n');
execFileSync('git',['-C',project,'add','.']);
execFileSync('git',['-C',project,'-c','user.name=Synara QA','-c','user.email=qa@example.invalid','commit','-m','Disposable fixture']);
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(source,process.env.QA_SOURCE); assert.equal(tree,process.env.QA_TREE);
const results={source,tree,cases:[],pageErrors:[],screenshots:[],serverExits:[],boundary:'Real server and disk; no mocked transport, no cloud-provider request'};
let server,browser,context,page;
const log=createWriteStream(join(out,'server.log'));
async function poll(name,fn,ms=15000){let last;const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw new Error(`${name}: ${last?.message??'deadline exceeded'}`);}
async function shot(name){await page.screenshot({path:join(out,name+'.png'),fullPage:true});results.screenshots.push(name);}
async function check(name,fn){const start=Date.now();try{await fn();results.cases.push({name,status:'pass',milliseconds:Date.now()-start});return true;}catch(e){results.cases.push({name,status:'fail',error:String(e.stack??e),milliseconds:Date.now()-start});if(page){await shot('failure-'+results.cases.length).catch(()=>{});await writeFile(join(out,'failure-'+results.cases.length+'.txt'),await page.locator('body').innerText().catch(()=>''));}return false;}}
async function dismiss(){for(const name of ['Skip setup','Skip tour']){const b=page.getByRole('button',{name,exact:true});try{await b.waitFor({state:'visible',timeout:3500});await b.click();await expect(b).toBeHidden();}catch(e){if(await b.isVisible())throw e;}}}
async function selectFile(query,name){await page.keyboard.press('Escape');await page.keyboard.press('Control+k');const input=page.getByPlaceholder('Search chats or run a command');await expect(input).toBeVisible();await input.fill(query);const option=page.getByRole('option').filter({hasText:name});await expect(option).toHaveCount(1);await option.click();await expect(input).toBeHidden();await expect(page.getByRole('navigation',{name:'File path'}).filter({hasText:name})).toBeVisible();}
async function replaceSource(text){const editor=page.getByRole('textbox').filter({hasText:/export const message/});await expect(editor).toBeVisible();await editor.click();await page.keyboard.press('Control+a');await page.keyboard.type(text);await page.keyboard.press('Enter');return editor;}
try{
 const socket=createServer();await new Promise((res,rej)=>{socket.once('error',rej);socket.listen(0,'127.0.0.1',res);});const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`;
 const env={...process.env,HOME:home,SYNARA_HOME:home};for(const key of ['SYNARA_AUTH_TOKEN','SYNARA_PUBLIC_URL','VITE_DEV_SERVER_URL','VITE_WS_URL','SYNARA_DESKTOP_WS_URL','SYNARA_BROWSER_HOST_PIPE_PATH','SYNARA_BROWSER_HOST_CAPABILITY'])delete env[key];
 server=spawn(process.execPath,[join(root,'apps/server/dist/index.mjs'),'--mode','web','--host','127.0.0.1','--port',String(port),'--home-dir',home,'--no-browser'],{cwd:project,env,stdio:['ignore','pipe','pipe']});server.stdout.pipe(log,{end:false});server.stderr.pipe(log,{end:false});server.on('exit',(code,signal)=>results.serverExits.push({code,signal}));
 const ready=await check('real server reaches readiness with isolated home',()=>poll('readiness',async()=>{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)});const d=await r.json();return r.ok&&d.startupReady&&d.status==='ok';},60000));if(!ready)throw new Error('Startup failed; dependent journeys not run');
 browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',recordVideo:{dir:join(out,'video'),size:{width:1440,height:1000}}});await context.tracing.start({screenshots:true,snapshots:true,sources:false});page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>results.pageErrors.push(String(e)));results.browser=browser.version();
 const created=await check('real UI creates a project and preserves an unsent draft',async()=>{await page.goto(base);await dismiss();await page.locator('[class~="group/project-header"]').filter({hasText:'Projects'}).first().hover();await page.getByRole('button',{name:'Add project',exact:true}).first().click();const d=page.getByRole('dialog',{name:'Create project',exact:true});await d.getByRole('textbox',{name:'Project folder path',exact:true}).fill(project);await d.getByRole('button',{name:'Create project',exact:true}).click();await expect(d).toBeHidden();const editor=page.getByTestId('composer-editor');await expect(editor).toBeVisible();await editor.fill('Unsent draft must survive file workflows');await shot('01-project-draft');});if(!created)throw new Error('Project setup failed; dependent journeys not run');
 const opened=await check('Cmd+K finds a real workspace file and opens its preview',async()=>{await selectFile('README','README.md');await page.getByRole('radio',{name:'Preview',exact:true}).click();await expect(page.getByRole('heading',{name:'Workspace acceptance',exact:true})).toBeVisible();await shot('02-real-markdown');});
 if(opened){
  await check('Mermaid renders through the production file-preview renderer',async()=>{const diagram=page.getByRole('img',{name:'Mermaid diagram',exact:true});await expect(diagram).toBeVisible();await expect.poll(()=>diagram.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);await shot('03-mermaid');});
  await check('file find counts and navigates real rendered content without losing draft',async()=>{await page.getByRole('button',{name:'Find in file',exact:true}).click();const find=page.getByRole('textbox',{name:'Find in file',exact:true});await find.fill('Needle');await expect(page.getByText('1 / 2',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Next match (Enter)',exact:true}).click();await expect(page.getByText('2 / 2',{exact:true})).toBeVisible();await shot('04-find-second-match');await page.getByRole('button',{name:'Close find (Esc)',exact:true}).click();await expect(find).toBeHidden();await expect(page.getByTestId('composer-editor')).toContainText('Unsent draft must survive file workflows');});
 }
 await check('workspace search opens Unicode filenames through real transport',async()=>{await selectFile('unicod','unicodé-文件.txt');await expect(page.locator('[data-workspace-file-preview]').filter({hasText:'Unicode file content'})).toBeVisible();await shot('05-unicode-file');});
 const saved=await check('native editor input and Save update the actual file and Git diff',async()=>{const url=new URL(page.url());url.searchParams.set('view','editor');url.searchParams.set('editorFilePath','sample.ts');await page.goto(url.href);await page.getByRole('button',{name:'Edit file',exact:true}).click();const editor=await replaceSource('export const message = "QA real save";');await page.keyboard.press('Control+s');await poll('saved disk bytes',async()=>(await readFile(join(project,'sample.ts'),'utf8')).includes('QA real save'));await expect(editor).toContainText('QA real save');const diff=execFileSync('git',['-C',project,'diff','--','sample.ts'],{encoding:'utf8'});assert(diff.includes('+export const message = "QA real save";'));await shot('06-real-saved-editor');results.savedDiff=diff;});
 if(saved){
  await check('clean editor receives an external on-disk change',async()=>{await writeFile(join(project,'sample.ts'),'export const message = "QA external write";\n');await expect(page.getByRole('textbox').filter({hasText:/export const message/})).toContainText('QA external write');await shot('07-external-update');});
  await check('conflicting save preserves both external file and unsaved local buffer',async()=>{const editor=await replaceSource('export const message = "QA local unsaved";');await writeFile(join(project,'sample.ts'),'export const message = "QA authoritative external";\n');await page.keyboard.press('Control+s');await expect(page.getByRole('button',{name:'Overwrite',exact:true})).toBeVisible();assert.equal(await readFile(join(project,'sample.ts'),'utf8'),'export const message = "QA authoritative external";\n');await expect(editor).toContainText('QA local unsaved');await expect(page.getByLabel('Unsaved changes',{exact:true})).toBeVisible();await shot('08-save-conflict');});
 }
 await check('no unhandled renderer exceptions',async()=>assert.deepEqual(results.pageErrors,[]));
}catch(e){results.fatal=String(e.stack??e);}finally{
 if(context){await context.tracing.stop({path:join(out,'workspace-trace.zip')}).catch(e=>results.traceError=String(e));await context.close();}if(browser)await browser.close();
 if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');try{await poll('owned server exit',()=>server.exitCode!==null||server.signalCode!==null,15000);}catch(e){server.kill('SIGKILL');await poll('forced owned exit',()=>server.exitCode!==null||server.signalCode!==null,5000).catch(()=>{});results.cleanupError=String(e);}}
 log.end();await writeFile(join(out,'workspace-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
}
if(results.fatal||results.cleanupError||results.cases.some(c=>c.status!=='pass'))process.exitCode=1;
