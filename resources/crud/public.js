const managing = new URLSearchParams(location.search).has('manage');
el(managing ? 'manager' : 'public').hidden = false;
if (!managing) {
  try {
    const source = el('design-source');
    if (source) {
      const parsed = new DOMParser().parseFromString(source.content.textContent, 'text/html');
      // Rebuild inert layout elements. Remote content never supplies attributes or executable markup.
      function copy(node, parent) {
        if (node.nodeType === Node.TEXT_NODE) { parent.append(node.textContent); return; }
        if (!/^(MAIN|HEADER|FOOTER|SECTION|ARTICLE|DIV|SPAN|P|H[1-6]|STRONG|EM|UL|OL|LI|NAV|A|BUTTON)$/.test(node.tagName)) return;
        const block = document.createElement(/^(MAIN|A|BUTTON)$/.test(node.tagName) ? 'div' : node.tagName.toLowerCase());
        for (const property of ['color','backgroundColor','fontSize','fontWeight','textAlign','borderRadius']) block.style[property] = node.style[property];
        for (const child of node.childNodes) copy(child, block);
        parent.append(block);
      }
      for (const node of parsed.body.childNodes) copy(node, el('design'));
    }
    const rows = await request('/api/' + active.key);
    for (const row of rows) {
      const card = element('article', '');
      card.append(element('h3', row.name ?? row.title), element('p', row.description),
        element('strong', row.price === undefined ? row.category : 'Price · ' + Number(row.price).toFixed(2)));
      el('cards').append(card);
    }
    if (!rows.length) el('public-status').textContent = 'No entries yet.';
  } catch (error) { el('public-status').textContent = error.message; }
}
