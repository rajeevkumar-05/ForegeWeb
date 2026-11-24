import { ApiError } from '../lib.ts';
import type { MasterSpecification } from '../domain.ts';

export type CrudField = { key: string; label: string; type: 'text' | 'number' | 'integer' | 'email' | 'date'; required: boolean; unique: boolean; min?: number; max?: number };
export type CrudResource = { key: string; label: string; fields: CrudField[] };
export type CrudPlan = { title: string; resources: CrudResource[] };

const hint = 'Example: Build a library CRUD website. Books: title, ISBN (unique), price (number, min 0); Members: name, email.';
function clarify(message: string): never { throw new ApiError(422, 'CRUD_PROMPT_NEEDS_DETAIL', message + ' ' + hint); }
const keyOf = (label: string) => label.toLowerCase().trim().replace(/[ -]+/g, '_');
const labelOf = (raw: string) => raw.trim().replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase());
const namePattern = /^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+){0,3}$/i;
const reserved = /^(?:id|constructor|prototype|__proto__|rowid|oid|_rowid_)$/i;
const prose = /\b(?:allow|should|must|when|which|cannot|can|is|are|has|have|support|include|enable|also|add|create|read|list|view|update|delete|edit|filter|search|sort|login|authentication|roles?|dashboard|report|export|send|remind|between|greater|less|only|with|and|or|for|by)\b/i;
function field(raw: string): CrudField {
  const match = raw.trim().match(/^([^()]+?)(?:\s*\(([^()]+)\))?$/);
  if (!match) clarify('Unrecognized field: ' + raw);
  let name = match[1].trim();
  const rules = (match[2] ?? '').toLowerCase().split(/\s*,\s*|\s+and\s+/).filter(Boolean);
  name = name.replace(/^(unique|required|optional|non-negative)\s+/i, (_, rule: string) => { rules.unshift(rule.toLowerCase()); return ''; });
  if (!namePattern.test(name) || reserved.test(keyOf(name)) || prose.test(name) || /\b(?:unique|required|optional|negative|minimum|maximum)\b/i.test(name)) clarify('Give this field a label and put its rules in parentheses: ' + raw);
  const key = keyOf(name);
  if (rules.includes('required') && rules.includes('optional')) clarify('Conflicting required and optional rules on ' + name);
  const types = new Set(rules.filter(rule => ['text', 'number', 'integer', 'email', 'date'].includes(rule)));
  if (types.size > 1) clarify('Choose one field type for ' + name);
  const amount = /(?:^|_)(?:fees?|prices?|cost|amount|salary|balance|rate)$/.test(key);
  const count = /(?:^|_)(?:quantity|stock|count|age|units)$/.test(key);
  const result: CrudField = { key, label: labelOf(name), type: amount ? 'number' : count ? 'integer' : /(?:^|_)email$/.test(key) ? 'email' : /(?:^|_)date$/.test(key) ? 'date' : 'text', required: true, unique: /^(?:usn|isbn|sku)$/.test(key) };
  if ((amount || count) && (!types.size || types.has('number') || types.has('integer'))) result.min = 0;
  for (const rule of rules) {
    if (rule === 'unique') result.unique = true;
    else if (rule === 'optional' || rule === 'required') result.required = rule === 'required';
    else if (['text', 'number', 'integer', 'email', 'date'].includes(rule)) result.type = rule as CrudField['type'];
    else if (/^non[- ]negative(?: (?:number|integer))?$/.test(rule)) { result.min = 0; result.type = rule.endsWith('integer') || result.type === 'integer' ? 'integer' : 'number'; }
    else {
      const bound = /^(min|max)\s+(-?\d+(?:\.\d+)?)$/.exec(rule);
      if (!bound) clarify('Unknown rule "' + rule + '" on ' + name + '.');
      result[bound[1] as 'min' | 'max'] = Number(bound[2]);
      if (result.type === 'text') result.type = 'number';
    }
  }
  if ((result.min !== undefined || result.max !== undefined) && !['number', 'integer'].includes(result.type)) clarify('Numeric limits need a numeric field: ' + name);
  if ([result.min, result.max].some(n => n !== undefined && (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER))) clarify('Numeric limits exceed the supported range on ' + name);
  if (result.min !== undefined && result.max !== undefined && (result.min > result.max || (result.type === 'integer' && Math.ceil(result.min) > Math.floor(result.max)))) clarify('No valid value within the limits on ' + name);
  return result;
}
function onlyOperations(text: string, resources: CrudResource[]) {
  const normalized = text.toLowerCase().replace(/^(?:(?:it|the (?:system|website|app)) should (?:let|allow) users to |(?:allow|enable) users to |users (?:should be able to|can) )/, '');
  const words = normalized.split(/[\s,\/]+/).filter(Boolean);
  const last = words.at(-1);
  if (resources.some(r => r.key === last || r.key + 's' === last)) words.pop();
  return words.some(w => /^(?:crud|add|create|delete|edit|search|read|list|view|update|remove)$/.test(w))
    && words.every(w => /^(?:allow|support|enable|users|can|full|basic|all|crud|operations?|records?|and|create|add|read|view|list|edit|update|delete|remove|search)$/.test(w));
}
function resource(name: string, list: string): CrudResource {
  if (!namePattern.test(name) || reserved.test(keyOf(name)) || prose.test(name)) clarify('Give each collection a short name: ' + name);
  const parts = list.replace(/\s+(?:and|with)\s+(?:full |basic )?CRUD(?: operations?)?$/i, '').split(/(?:,\s*(?:and\s+)?|\s+and\s+)(?![^()]*\))/i);
  const fields = parts.map(field);
  if (new Set(fields.map(f => f.key)).size !== fields.length) clarify('Duplicate field in ' + name + '.');
  return { key: keyOf(name), label: labelOf(name), fields };
}
function cleanTitle(raw: string): string {
  return raw.trim().replace(/^(?:(?:please|build|create|generate|make|me|a|an|the|simple|basic|local)\s+)+/i, '').replace(/\s+(?:with )?(?:basic |full )?CRUD(?: operations?)?$/i, '').trim();
}
function collectionFrom(raw: string): string {
  const title = cleanTitle(raw);
  const forName = /\bfor\s+(.+)$/i.exec(title);
  return (forName?.[1] ?? title).replace(/^(?:a |an |the )/i, '').replace(/\b(?:crud|management|system|website|web app|application|app|manager|tracker|register|directory|database|catalog|records?)\b/gi, '').trim();
}
export function parseCrudPrompt(prompt: string): CrudPlan | undefined {
  const declaresFields = /\b(?:fields?|columns?)\s*[:=]|\bwith\b[^.!;\n]*(?:,|\band\b)/i.test(prompt);
  const intent = /\bcrud\b|\bmanagement system\b|\b(?:create|add)\b[^.!]*(?:\bedit\b|\bupdate\b)[^.!]*\b(?:delete|remove)\b/i.test(prompt)
    || (declaresFields && /\b(?:tracker|register|directory|manager|database|catalog|management|fields?|columns?|(?:website|application|app) for)\b/i.test(prompt));
  if (!intent) return;
  const sentences = prompt.trim().replace(/\.(?=\d)/g, '\u0001').split(/[.;\n]+/).map(s => s.replaceAll('\u0001', '.').trim()).filter(Boolean);
  let title = '';
  const resources: CrudResource[] = [];
  for (const [i, sentence] of sentences.entries()) {
    if (onlyOperations(sentence, resources)) continue;
    const named = /^([\w -]+?):\s*(.+)$/.exec(sentence);
    if (named && !/\b(?:fields?|columns?|with|build|create|generate)\b/i.test(named[1])) { resources.push(resource(named[1].trim(), named[2])); continue; }
    const inline = /^(.+?)\s+(?:with(?:\s+(?:(?:the|these|following)\s+)*(?:fields?|columns?))?|fields?|columns?)\s*[:=]?\s+(.+)$/i.exec(sentence);
    if (i === 0 && inline) { title = cleanTitle(inline[1]); resources.push(resource(collectionFrom(inline[1]), inline[2])); continue; }
    const fields = /^(?:track|store|fields?|columns?|each [a-z]+ (?:has|should have|must have))\s*:?\s+(.+)$/i.exec(sentence);
    if (fields && title && !resources.length) { resources.push(resource(collectionFrom(title), fields[1])); continue; }
    const constraint = /^(.+?)\s+(?:must be|should be|is|are|cannot be|must not be)\s+(unique|required|optional|non[- ]negative|negative)$/i.exec(sentence);
    if (constraint) {
      const matches = resources.flatMap(r => r.fields).filter(f => f.key === keyOf(constraint[1]));
      if (matches.length !== 1) clarify('The rule must name exactly one field: ' + sentence);
      const f = matches[0], rule = constraint[2].toLowerCase();
      if (/\b(?:cannot be|must not be)\b/i.test(sentence) && rule !== 'negative') clarify('Unsupported negative requirement: ' + sentence);
      if (rule === 'unique') f.unique = true;
      else if (rule === 'required' || rule === 'optional') f.required = rule === 'required';
      else if (/\b(?:cannot be|must not be) negative$/i.test(sentence) || /\b(?:must be|should be|is|are) non[- ]negative$/i.test(sentence)) { if (f.type === 'text') f.type = 'number'; if (!['integer','number'].includes(f.type)) clarify('Numeric rule on ' + f.label); f.min = Math.max(0, f.min ?? 0); }
      else clarify('Unsupported numeric rule: ' + sentence);
      continue;
    }
    if (i === 0 && sentences.length > 1 && !sentence.includes(':')) { title = cleanTitle(sentence); if (!namePattern.test(collectionFrom(title)) || prose.test(collectionFrom(title))) clarify('Use a short project title before the collections.'); continue; }
    if (named && /^(?:fields?|columns?)$/i.test(named[1]) && title) { resources.push(resource(collectionFrom(title), named[2])); continue; }
    clarify('Could not map this part to a collection, field or CRUD action: "' + sentence + '".');
  }
  if (!resources.length) clarify('List the fields to store for each collection.');
  if (new Set(resources.map(r => r.key)).size !== resources.length) clarify('Each collection needs a different name.');
  return { title: labelOf(title || resources.map(r => r.label).join(' and ')), resources };
}

export function applyCrudPlan(base: MasterSpecification, crud: CrudPlan): MasterSpecification {
  const entities = crud.resources.map(r => r.label);
  const requirements = crud.resources.map((r, i) => {
    const fields = r.fields.map(f => f.label + ' (' + [f.type, f.required ? 'required' : 'optional', f.unique && 'unique', f.min !== undefined && 'min ' + f.min, f.max !== undefined && 'max ' + f.max].filter(Boolean).join(', ') + ')');
    return { id: 'REQ-' + String(i + 1).padStart(3, '0'), title: r.label, description: fields.join('; '), acceptanceCriteria: ['Create, list, search, edit and delete ' + r.label + ' records.', 'Persist changes across restart and reject invalid input.'], priority: 'P0' as const };
  });
  const routes = crud.resources.flatMap(r => {
    const path = '/api/' + r.key;
    return ['GET ' + path, 'POST ' + path, 'GET ' + path + '/{id}', 'PATCH ' + path + '/{id}', 'DELETE ' + path + '/{id}'];
  });
  const markdown = '# ' + crud.title + '\n\nLocal single-user website. Browser forms use a same-origin Node.js API backed by SQLite.\n\n' + requirements.map(r => '## ' + r.title + '\n' + r.description).join('\n\n') + '\n\n' + routes.join('\n');
  return { ...base, crud, productName: crud.title, productKind: 'generic', summary: 'Create, search, edit and delete records stored in a project-specific SQLite database.', roles: ['Local operator'], entities, requirements,
    assumptions: ['Single-user, loopback-only application.', 'Search matches displayed field values. Unique text fields ignore case. Review field types and constraints before confirmation.'],
    generator: { mode: 'deterministic', provider: 'forgeweb-local', model: 'forgeweb-crud-v1', message: 'Built-in CRUD generator using the approved collection and field definitions.' },
    architecture: { systemShape: 'Browser → local HTTP API → SQLite', frontend: { framework: 'Browser HTML and JavaScript', pages: entities, components: ['Record form', 'Search', 'Record list'], motion: [] }, backend: { runtime: 'Node.js', apiStyle: 'JSON HTTP', modules: ['Validation', 'Record storage'], jobs: [], routes }, data: { database: 'SQLite', entities, rules: requirements.map(r => r.description) }, security: ['Loopback-only', 'Same-origin writes', 'Server-side field validation'], delivery: ['Standalone Node.js app', 'Executable CRUD acceptance checks'], diagram: 'flowchart LR\n Browser --> API --> SQLite', markdown, capabilities: [] } };
}
