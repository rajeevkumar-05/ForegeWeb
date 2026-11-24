import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fromBufferPromise } from 'yauzl';
import { buffer } from 'node:stream/consumers';
import { parseCrudPrompt } from '../crud/plan.ts';
import { BuildWorkflow } from '../workflow.ts';
import { JsonStore } from '../store.ts';
import { ProjectRuntime } from '../project-runtime.ts';
import type { ApplicationGenerationProvider } from '../providers/generation-provider.ts';

const prompts = [
  'Build a student management system with student name, fees, USN and branch.',
  'Build an equipment tracker with unique asset tag, purchase date, cost (number, min 0.25, max 500), notes (optional).',
  'Build a library CRUD website. Books: title, ISBN (unique), author; Members: name, email (unique), joining date.'
];
async function wait(workflow: BuildWorkflow, id: string, status: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const build = workflow.get(id);
    if (build.status === status) return build;
    if (build.status === 'failed') throw Error(build.error?.message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Timed out waiting for ' + status);
}
test('prompt contracts preserve fields, normalized keys, separate collections and explicit rules', () => {
  const student = parseCrudPrompt(prompts[0])!.resources[0];
  assert.deepEqual(student.fields.map(f=>f.key), ['student_name','fees','usn','branch']);
  assert.equal(student.fields[1].min, 0); assert.equal(student.fields[2].unique, true);
  const equipment = parseCrudPrompt(prompts[1])!.resources[0];
  assert.equal(equipment.fields[2].min, .25); assert.equal(equipment.fields[3].required, false);
  assert.deepEqual(parseCrudPrompt(prompts[2])!.resources.map(r=>r.key), ['books','members']);
  const plan = parseCrudPrompt('Build a supplier management system. Fields: vendor code, name, credit. Vendor code must be unique. Credit cannot be negative. Create, read, update and delete records.')!;
  assert.equal(plan.resources[0].fields[0].unique,true); assert.equal(plan.resources[0].fields[2].min,0);
  assert.deepEqual(parseCrudPrompt(prompts[0] + ' Allow users to add, view, edit and delete students.'), parseCrudPrompt(prompts[0]));
});
for (const prompt of [
  'Build a CRM CRUD website with name, email and email.',
  'Build a CRUD website for notes.',
  'Build a library CRUD website. Books: title, ISBN; send overdue reminders.',
  'Build an asset CRUD app with name and price (number, min 20, max 3).',
  'Build a book CRUD app with name and rating (approved values).',
  'Build a book CRUD app with name and id.',
  'Build a book CRUD app with name, title (optional, required).',
  'Build a book CRUD app with name, sales (integer, date).',
  'Build a book CRUD app with name and author. Author cannot be unique.'
]) test('ambiguous or unsupported requirement stops planning: ' + prompt, () => {
  assert.throws(()=>parseCrudPrompt(prompt), { code:'CRUD_PROMPT_NEEDS_DETAIL' });
});
for (const [index, prompt] of prompts.entries()) test('approved local build, runtime, persistence and export: ' + prompt, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crud-build-'));
  const store = new JsonStore(dir);
  await store.initialize();
  const never = async (): Promise<never> => { throw Error('Unexpected external generation'); };
  const provider: ApplicationGenerationProvider = {id:'openai',mode:'ai',model:'unused',plan:never,generate:never};
  const workflow = new BuildWorkflow(store, 0, provider, {design:never});
  const runtime = new ProjectRuntime(workflow.workspace, dir);
  try {
    const build = await workflow.create(prompt);
    const proposal = await wait(workflow,build.id,'awaiting_confirmation');
    assert.equal(proposal.filePaths.length,0); assert.equal(proposal.specification!.generator?.model,'forgeweb-crud-v1');
    await workflow.confirm(build.id);
    const completed = await wait(workflow,build.id,'completed');
    assert.match(completed.validationChecks.at(-1)!.evidence,/HTTP assertions passed/);
    const project = build.projectId, version = completed.project.currentVersionId!;
    const live = await runtime.start(project, version);
    assert.equal(live.status,'running');
    const schema = await (await fetch(live.url + '/schema.json')).json();
    assert.deepEqual(schema, proposal.specification!.crud);
    const workspace = await workflow.workspace.getReady(project);
    assert.equal(workspace.currentVersion!.id,version);
    const exported = await workflow.workspace.export(project);
    assert.equal(exported.summary.validation, 'passed');
    if (index === 0) {
      const path = '/api/student';
      const data = {student_name:'QA Student',fees:100,usn:'QA-01',branch:'Physics'};
      const write = (method:string,route:string,value:object) => fetch(live.url + route,{method, headers:{'content-type':'application/json'},body:JSON.stringify(value)});
      const writes = await Promise.all([write('POST',path,data),write('POST',path,{...data,usn:'qa-01'})]);
      assert.deepEqual(writes.map(w=>w.status).sort(), [201,409]);
      const row = await writes.find(w=>w.status===201)!.json() as typeof data & {id:string};
      const second = await (await write('POST',path,{...data,usn:'QA-02'})).json() as {id:string};
      assert.equal((await write('PATCH',path+'/'+second.id,{usn:row.usn,fees:999})).status,409);
      assert.equal((await write('PATCH',path+'/'+row.id,{fees:-1})).status,422);
      assert.deepEqual(await (await fetch(live.url+path+'/'+row.id)).json(),row);
      assert.equal((await (await fetch(live.url+path+'/'+second.id)).json() as typeof data).fees,100);
      await runtime.stop(project);
      const restarted = await runtime.start(project,version);
      assert.deepEqual(await (await fetch(restarted.url+path+'/'+row.id)).json(),row);
      assert.equal((await runtime.storage(project,'student')).total,2);
      assert.equal((await runtime.validate(project,version)).currentVersion?.validationStatus,'passed');
      assert.equal((await runtime.storage(project,'student')).total,2);
    }
    const root=join(dir,'export');
    const archive = await fromBufferPromise(exported.archive);
    const remaining = new Map(workspace.files.map(f => [f.path, f.content]));
    try {
      for await (const entry of archive.eachEntry()) {
        assert.ok(remaining.has(entry.fileName), 'Unexpected ZIP entry ' + entry.fileName);
        const bytes = await buffer(await archive.openReadStreamPromise(entry));
        assert.equal(bytes.toString('utf8'), remaining.get(entry.fileName));
        remaining.delete(entry.fileName);
        const path = join(root, entry.fileName);
        await mkdir(dirname(path), {recursive:true}); await writeFile(path, bytes);
      }
    } finally { archive.close(); }
    assert.equal(remaining.size, 0);
    await promisify(execFile)(process.execPath,['--test','tests/application.test.mjs'],{cwd:root,timeout:15000});
    await runtime.stop(project);
    await store.mutate(state=>{state.versionFiles[version].find(f=>f.path==='frontend/app.js')!.content='';});
    assert.equal((await workflow.workspace.validateExport(project)).validation,'failed');
    await assert.rejects(runtime.start(project,version),{code:'CRUD_SOURCE_CHANGED'});
  } finally { await runtime.shutdown(); store.close(); await rm(dir,{recursive:true,force:true}); }
});
test('strict workflow refuses an unspecified application without publishing template files', async () => {
  const dir = await mkdtemp(join(tmpdir(),'crud-stop-')), store = new JsonStore(dir);
  await store.initialize();
  try {
    const workflow=new BuildWorkflow(store,0), build=await workflow.create('Build an application for our office.');
    const result = await wait(workflow,build.id,'failed');
    assert.equal(result.error?.code,'CRUD_PROMPT_NEEDS_DETAIL');assert.deepEqual(result.filePaths,[]);assert.equal(result.project.currentVersionId,undefined);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
