const el = id => document.getElementById(id);
const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
let active, editing, sequence = 0, busy = false;
const message = text => { el('message').textContent = text; };
async function request(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  if (response.status === 204) return;
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error || 'Request failed.');
  return payload;
}
function button(label, fn) {
  const b = element('button', label);
  b.type = 'button';
  b.onclick = () => Promise.resolve().then(fn).catch(error => message(error.message));
  return b;
}
function form(row) {
  editing = row?.id;
  el('form-title').textContent = editing ? 'Edit record' : 'Add record';
  const inputs = active.fields.map(f => {
    const label = element('label', f.label + (f.required ? '' : ' (optional)'));
    const input = document.createElement('input');
    input.name = f.key;
    input.type = f.type === 'integer' ? 'number' : f.type;
    input.required = f.required;
    if (f.type === 'number') input.step = 'any';
    if (f.min !== undefined) input.min = String(f.min);
    if (f.max !== undefined) input.max = String(f.max);
    input.value = row?.[f.key] ?? '';
    label.append(input);
    return label;
  });
  const save = element('button', editing ? 'Save changes' : 'Add record');
  save.type = 'submit';
  el('record-form').replaceChildren(...inputs, save);
  if (editing) el('record-form').append(button('Cancel edit', () => form()));
}
async function refresh() {
  const generation = ++sequence;
  const records = await request('/api/' + active.key + '?q=' + encodeURIComponent(el('search').value));
  if (generation !== sequence) return;
  const rows = records.map(row => {
    const tr = document.createElement('tr');
    for (const f of active.fields) tr.append(element('td', String(row[f.key] ?? '')));
    const actions = element('td', '');
    actions.className = 'actions';
    actions.append(button('Edit', () => { form(row); el('record-form').querySelector('input').focus(); }), button('Delete', () => {
      const collection = active;
      actions.replaceChildren(button('Confirm delete', async () => {
        await request('/api/' + collection.key + '/' + row.id, 'DELETE');
        if (active !== collection) return;
        if (editing === row.id) form();
        message('Record deleted.'); await refresh();
      }), button('Cancel', refresh));
    }));
    tr.append(actions); return tr;
  });
  el('rows').replaceChildren(...rows);
  el('empty').hidden = !!rows.length;
  el('empty').textContent = el('search').value ? 'No matching records.' : 'No records yet.';
}
async function select(resource) {
  active = resource; message(''); el('search').value = ''; el('rows').replaceChildren();
  for (const b of el('collections').children) b.setAttribute('aria-pressed', String(b.dataset.key === active.key));
  el('list-title').textContent = resource.label;
  const tr = document.createElement('tr');
  tr.append(...resource.fields.map(f => element('th', f.label)), element('th', 'Actions'));
  el('head').replaceChildren(tr); form(); await refresh();
}
el('record-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const collection = active, id = editing;
  const fields = new FormData(event.currentTarget);
  const data = Object.fromEntries(collection.fields.map(f => {
    const value = fields.get(f.key);
    return [f.key, value === '' ? null : ['integer','number'].includes(f.type) ? Number(value) : value];
  }));
  busy = true;
  try {
    await request('/api/' + collection.key + (id ? '/' + id : ''), id ? 'PATCH' : 'POST', data);
    if (active !== collection) return;
    form(); el('search').value = ''; message(id ? 'Changes saved.' : 'Record added.'); await refresh();
  } catch (error) { message(error.message); } finally { busy = false; }
};
el('search').oninput = () => refresh().catch(error => message(error.message));
try {
  const plan = await request('/schema.json');
  document.title = el('title').textContent = plan.title;
  for (const r of plan.resources) { const b = button(r.label, () => select(r)); b.dataset.key = r.key; el('collections').append(b); }
  await select(plan.resources[0]);
} catch (error) { message(error.message); }
