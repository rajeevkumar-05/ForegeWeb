import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCrudServer, openRecords } from '../../resources/crud/engine.mjs';
import { verifyCrud } from '../../resources/crud/verify.mjs';
import { digest, id, slugify } from '../lib.ts';
import type { GeneratedFile, MasterSpecification, ValidationCheck } from '../domain.ts';
import type { CrudPlan } from './plan.ts';

const asset = (name: string) => readFileSync(resolve('resources/crud', name), 'utf8');
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const launcher = `import { readFileSync } from 'node:fs';
import { createCrudServer, openRecords } from './engine.mjs';
export const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
export const plan = JSON.parse(read('shared/crud.json'));
export function open(path) {
  const db = openRecords(path);
  return { db, server: createCrudServer(plan, db, read('frontend/index.html'), read('frontend/app.js')) };
}
`;
export function crudFiles(spec: MasterSpecification): GeneratedFile[] {
  const plan = spec.crud!;
  const requirements = spec.requirements.map(r => r.id);
  const preview = '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(plan.title) + '</title><main style="font:16px system-ui;padding:3%;color:#184e50"><header><h1>' + escape(plan.title) + '</h1></header><p>Start live preview to manage saved records.</p>' + spec.requirements.map(r => '<section><h2>' + escape(r.title) + '</h2><p>' + escape(r.description) + '</p></section>').join('') + '</main></html>';
  const contents: Record<string, string> = {
    'shared/crud.json': JSON.stringify(plan, null, 2), 'frontend/preview.html': preview,
    'frontend/index.html': asset('index.html'), 'frontend/app.js': asset('app.js'), 'backend/engine.mjs': asset('engine.mjs'),
    'backend/application.mjs': launcher, 'tests/verify.mjs': asset('verify.mjs').replace("from './engine.mjs'", "from '../backend/engine.mjs'"),
    'backend/start.mjs': "import { open } from './application.mjs';\nimport { startServer } from './engine.mjs';\nconst session = open(process.env.APP_DATABASE_PATH || 'application.sqlite');\nconsole.log(await startServer(session.server, Number(process.env.PORT || 3000)));\n",
    'tests/application.test.mjs': "import test from 'node:test';\nimport { open, plan } from '../backend/application.mjs';\nimport { verifyCrud } from './verify.mjs';\ntest('Approved CRUD workflows', () => verifyCrud(plan, open));\n",
    'package.json': JSON.stringify({ name: slugify(plan.title), private: true, type: 'module', engines: { node: '>=22.13.0' }, scripts: { start: 'node backend/start.mjs', test: 'node --test tests/application.test.mjs' } }, null, 2),
    'README.md': '# ' + plan.title + '\n\nUse Node.js 22.13 or newer. Run `npm start` and open the printed local address. Run `npm test` for database-backed acceptance tests. No dependencies to install. SQLite data is saved in application.sqlite in the launch directory. This app is for a single local operator.\n',
    'REQUIREMENTS.md': spec.requirements.map(r => '## ' + r.title + '\n' + r.description + '\n' + r.acceptanceCriteria.join('\n')).join('\n\n'), 'ARCHITECTURE.md': spec.architecture.markdown
  };
  return Object.entries(contents).map(([path, content]) => ({ path, content, requirementIds: requirements, digest: digest(content) }));
}
export function crudSourceCheck(spec: MasterSpecification, files: GeneratedFile[]): ValidationCheck {
  const expected = crudFiles(spec);
  const byPath = new Map(files.map(file => [file.path, file.content]));
  const valid = files.length === expected.length && expected.every(f => byPath.get(f.path) === f.content);
  return { id: id('check'), name: 'Approved CRUD source', status: valid ? 'passed' : 'failed', evidence: valid ? 'Exported schema, frontend, server and acceptance suite match the approved CRUD implementation.' : 'Source differs from the approved CRUD implementation. Regenerate before running or exporting.' };
}
export function openCrud(plan: CrudPlan, path: string) {
  const db = openRecords(path);
  return { db, server: createCrudServer(plan, db, asset('index.html'), asset('app.js')) };
}
export async function verifyCrudFiles(spec: MasterSpecification, files: GeneratedFile[]): Promise<ValidationCheck[]> {
  const source = crudSourceCheck(spec, files);
  if (source.status === 'failed') return [source];
  const check: ValidationCheck = { id: id('check'), name: 'CRUD HTTP and SQLite acceptance', status: 'failed', evidence: '' };
  try {
    const count = await verifyCrud(spec.crud!, path => openCrud(spec.crud!, path));
    check.status = 'passed'; check.evidence = count + ' HTTP assertions passed, including field validation, search, update, deletion and database reopen.';
  } catch (error) { check.evidence = error instanceof Error ? error.message : 'CRUD acceptance failed.'; }
  return [source, check];
}
