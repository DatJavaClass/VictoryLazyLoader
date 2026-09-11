/* Loader window and queue builder, ApplicationV2. */
import { MODULE_ID, TYPES, L, pathOf, findNodes, flatten, homeOf, packsOf } from './tree.js';
import { LOG, say, discover, rootsOf, resolve, plan, run, getQueue, runQueue } from './runner.js';

const { ApplicationV2, DialogV2 } = foundry.applications.api;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const count = (n) => n.docs.length + n.folders.reduce((a, c) => a + count(c), 0);
const names = (key) => Object.keys(game.settings.get(MODULE_ID, key)).sort();
const btn = (act, icon, key = '', extra = '') => `<button type="button" data-act="${act}" ${extra}><i class="fas fa-${icon}"></i>${key ? ` ${L(key)}` : ''}</button>`;
const list = (key, cur, act) => `<ul class="names" data-keep="${key}">${names(key).map((s) => `<li class="${cur === s ? 'active' : ''}" data-act="${act}" data-name="${esc(s)}">${esc(s)}</li>`).join('') || `<li class="notes">${L(key === 'sets' ? 'NoSets' : 'NoQueues')}</li>`}</ul>`;
const confirm = (key, n) => DialogV2.confirm({ window: { title: L('Title') }, content: `<p>${L(key)} (${n})</p>`, rejectClose: false });
const on = (root, evt, sel, fn) => root.addEventListener(evt, (ev) => { const t = ev.target.closest(sel); if (t && root.contains(t)) fn(t, ev); }); /* delegated listener */

/* HTML string in, scroll kept across renders. */
class VllApp extends ApplicationV2 {
  async _renderHTML() { return this.html(); }
  _replaceHTML(html, content) {
    const keep = [...content.querySelectorAll('[data-keep]')].map((el) => [el.dataset.keep, el.scrollTop]);
    content.innerHTML = html;
    for (const [k, top] of keep) { const el = content.querySelector(`[data-keep="${k}"]`); if (el) el.scrollTop = top; }
  }
  _onFirstRender() { this.bind(this.element); } /* frame persists, content swaps */
  _onRender() { this.element.querySelectorAll('button').forEach((b) => (b.disabled = this.busy)); } /* header close included */
}

export class LazyLoaderApp extends VllApp {
  static DEFAULT_OPTIONS = { id: 'vll-app', classes: ['vll', 'themed', 'theme-light'], window: { title: 'VLL.Title', resizable: true }, position: { width: 1040, height: 740 } };

  constructor(...args) {
    super(...args);
    this.data = null; /* null forces rebuild */
    this.members = new Set(); /* "type|pack|id", what moves */
    this.open = new Map(); /* details key -> open */
    this.tab = 'Actor';
    this.setName = '';
    this.queueName = '';
    this.builder = null;
    this.busy = false;
  }

  async _prepareContext() { this.data ??= await discover(); return {}; }
  hasSel(type) { return [...this.members].some((k) => k.startsWith(`${type}|`)); }
  rows() { return [...this.members].map((k) => { const [type, pack, id] = k.split('|'); return { type, pack, id, path: pathOf(rootsOf(this.data, type, pack), id) }; }); }

  /* Pack side checks, world side shows. */
  node(type, side, n, depth = 0, copy = false) {
    const key = `${type}|${side}|${n.id}`, world = side === 'world', isCopy = copy || (world && !!homeOf(type, n.id)), open = this.open.get(key) ?? !depth;
    const sw = n.color ? `<span class="sw" style="background:${esc(n.color)}"></span>` : '';
    const lead = world ? (isCopy ? `<i class="fas fa-link cnt" title="${L('Copy')}"></i> ` : '') : `<input type="checkbox" data-key="${key}" ${this.members.has(key) ? 'checked' : ''}>`;
    const adopt = world && !isCopy ? ` <button type="button" class="mini" data-act="adopt" data-type="${type}" data-id="${n.id}" title="${L('Adopt')}"><i class="fas fa-box"></i></button>` : '';
    return `<li><details ${open ? 'open' : ''} data-key="${key}"><summary class="${depth ? '' : 'top'}">${lead}${sw}${esc(n.name)} <span class="cnt">(${count(n)})</span>${adopt}</summary>
      <ul>${n.folders.map((c) => this.node(type, side, c, depth + 1, isCopy)).join('')}${n.docs.map((d) => `<li class="doc">${esc(d.name)}</li>`).join('')}</ul></details></li>`;
  }

  pane(type) {
    const d = this.data[type];
    const packHtml = d.packs.length ? d.packs.map((e) => `<details class="pack" open><summary>${esc(e.pack.metadata.label)} <span class="cnt">${e.pack.collection}</span> ${e.pack.locked ? '<i class="fas fa-lock cnt"></i>' : ''}</summary><ul>${e.tree.map((n) => this.node(type, e.pack.collection, n)).join('')}</ul></details>`).join('') : `<p class="notes">${L('NoPacks')}</p>`;
    const worldHtml = d.world.length ? `<ul>${d.world.map((n) => this.node(type, 'world', n)).join('')}</ul>` : `<p class="notes">${L('NoWorld')}</p>`;
    return `<div class="tab ${this.tab === type ? 'active' : ''}" data-tab="${type}">
      <div class="pane comp"><h3>${L('Compendiums')} <span class="hint">${L('CompHint')}</span></h3><div class="tree" data-keep="${type}-comp">${packHtml}</div></div>
      <div class="pane world"><h3>${L('World')} <span class="hint">${L('WorldHint')}</span></h3><div class="tree" data-keep="${type}-world">${worldHtml}</div></div>
    </div>`;
  }

  html() {
    const nav = TYPES.map((t) => `<a class="item ${this.tab === t ? 'active' : ''} ${this.hasSel(t) ? 'has-sel' : ''}" data-tab="${t}">${game.i18n.localize(`DOCUMENT.${t}`)}</a>`).join('');
    return `<aside class="rail">
        <h3>${L('Sets')}</h3>${list('sets', this.setName, 'pickSet')}
        <div class="row"><input type="text" name="setName" placeholder="${L('Name')}" value="${esc(this.setName)}">${btn('saveSet', 'save', '', `title="${L('SaveSet')}"`)}${btn('delSet', 'times', '', `title="${L('DeleteSet')}"`)}</div>
        <h3>${L('Queues')}</h3>${list('queues', this.queueName, 'pickQueue')}
        <div class="row">${btn('qunpack', 'box-open', 'unpack')}${btn('qrepack', 'box', 'repack')}${btn('build', 'list-ol', 'Build')}</div>
      </aside>
      <div class="main">
        <nav class="tabs">${nav}</nav>
        <div class="content">${TYPES.map((t) => this.pane(t)).join('')}</div>
        <footer>
          <div class="row">${btn('unpack', 'box-open', 'unpack')}${btn('repack', 'box', 'repack')}${btn('validate', 'check-double', 'validate', 'class="danger"')}${btn('clear', 'eraser', 'Clear')}${btn('refresh', 'sync', 'Refresh')}<span class="order">${L('Order')}: ${TYPES.join(' > ')}</span></div>
          <div class="bar" title="${L('Busy')}"><span></span><b>${this.busy ? '' : L('Idle')}</b></div>
          <div class="row"><b>${L('Log')}</b><span class="hint">${L('Busy')}</span>${btn('clearLog', 'broom', 'ClearLog')}</div>
          <div class="log" data-keep="log">${esc(LOG.join('\n') || L('Idle'))}</div>
        </footer>
      </div>`;
  }

  bind(root) {
    on(root, 'change', 'input[data-key]', (el) => this.toggle(el));
    on(root, 'click', 'nav .item', (el) => this.showTab(el.dataset.tab));
    on(root, 'click', '[data-act]', (el) => this.act(el.dataset.act, el.dataset));
    root.addEventListener('toggle', (ev) => { const k = ev.target.dataset?.key; if (k) this.open.set(k, ev.target.open); }, true); /* toggle never bubbles */
  }

  showTab(t) { this.tab = t; for (const el of this.element.querySelectorAll('[data-tab]')) el.classList.toggle('active', el.dataset.tab === t); }

  /* Check cascades down; uncheck also clears ancestors. */
  toggle(box) {
    const type = box.dataset.key.split('|')[0], on = box.checked, mark = (c) => { c.checked = on; this.members[on ? 'add' : 'delete'](c.dataset.key); };
    box.closest('details').querySelectorAll('input[data-key]').forEach(mark);
    if (!on) for (let d = box.closest('details').parentElement.closest('details'); d; d = d.parentElement.closest('details')) { const c = d.querySelector(':scope > summary input[data-key]'); if (c) mark(c); }
    this.element.querySelector(`nav .item[data-tab="${type}"]`).classList.toggle('has-sel', this.hasSel(type));
  }

  async act(act, ds = {}) {
    if (this.busy) return;
    const simple = { clear: () => { this.members.clear(); this.setName = ''; this.render(); }, refresh: () => { this.data = null; this.render(); }, saveSet: () => this.saveSet(), delSet: () => this.delSet(), clearLog: () => { LOG.length = 0; this.render(); },
      pickSet: () => this.applySet(ds.name), pickQueue: () => { this.queueName = ds.name; this.render(); }, build: () => (this.builder ??= new QueueBuilderApp(this)).render(true), qunpack: () => this.runQueue('unpack'), qrepack: () => this.runQueue('repack'), adopt: () => this.adopt(ds.type, ds.id) };
    if (simple[act]) return simple[act]();
    const { groups } = resolve(this.data, this.rows()), queue = plan(groups, act);
    if (!queue.length) return ui.notifications.warn(L('NothingSelected'));
    return this.guarded(async () => { if (act === 'unpack' || await confirm(act === 'repack' ? 'ConfirmRepack' : 'ConfirmDelete', queue.length)) await run(queue, L(act)); });
  }

  /* Busy lock around a run, then fresh trees. */
  async guarded(fn) {
    this.busy = true; this.render();
    try { await fn(); }
    finally { this.busy = false; this.data = null; say('re-indexing packs'); await this.render(); say('ready'); }
  }

  async runQueue(act) {
    const name = this.queueName;
    if (!name) return ui.notifications.warn(L('QueueNeedsPick'));
    return this.guarded(async () => { if (act === 'unpack' || await confirm('ConfirmQueueRepack', getQueue(name).length)) await runQueue(name, act); });
  }

  /* World only folder to pack root, then member. */
  async adopt(type, id) {
    const packs = packsOf(type), f = game.folders.get(id);
    if (!packs.length || !f) return ui.notifications.warn(L('NoPacks'));
    const pick = await DialogV2.wait({ window: { title: L('Adopt') }, content: `<p>${L('AdoptInto')}</p><p><b>${esc(f.name)}</b></p>`, rejectClose: false, buttons: packs.map((p) => ({ action: p.collection, label: `${p.metadata.label} (${p.metadata.packageName})` })) });
    if (!pick) return;
    const roots = findNodes(this.data[type].world, [id]);
    return this.guarded(async () => {
      if (await run(plan([{ type, pack: game.packs.get(pick), packRoots: [], worldRoots: roots }], 'repack'), `${L('Adopt')} "${f.name}"`)) this.members.add(`${type}|${pick}|${id}`);
    });
  }

  /* Sets store members only. */
  async sets(fn) { const s = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'sets')); fn(s); await game.settings.set(MODULE_ID, 'sets', s); this.render(); }

  async saveSet() {
    const name = this.element.querySelector('input[name=setName]').value.trim(), members = this.rows();
    if (!name) return ui.notifications.warn(L('SetNeedsName'));
    if (!members.length) return ui.notifications.warn(L('NothingSelected'));
    this.setName = name; say(`set "${name}" saved (${members.length} member(s))`);
    return this.sets((s) => { s[name] = { members }; });
  }

  async delSet() {
    const name = this.setName;
    if (!name) return;
    this.setName = ''; say(`set "${name}" forgotten`);
    return this.sets((s) => { delete s[name]; });
  }

  applySet(name) {
    const set = game.settings.get(MODULE_ID, 'sets')[name];
    if (!set) return;
    this.members.clear(); this.setName = name;
    const { groups, miss } = resolve(this.data, set.members ?? []);
    for (const g of groups) for (const n of flatten(g.packRoots).folders) this.members.add(`${g.type}|${g.pack.collection}|${n.id}`); /* whole subtree shows checked */
    say(`set "${name}" applied${miss ? `, ${miss} member(s) not found` : ''}`); this.render();
  }
}

/* Ordered set names, saved as a queue. */
export class QueueBuilderApp extends VllApp {
  static DEFAULT_OPTIONS = { id: 'vll-queue', classes: ['vll', 'themed', 'theme-light'], window: { title: 'VLL.QueueBuilder', resizable: true }, position: { width: 600, height: 460 } };

  constructor(parent) { super(); this.parent = parent; this.name = ''; this.list = []; }

  html() {
    const item = (s, i) => `<li>${i + 1}. ${esc(s)} <span>${btn('up', 'arrow-up', '', `data-i="${i}"`)}${btn('down', 'arrow-down', '', `data-i="${i}"`)}${btn('rm', 'times', '', `data-i="${i}"`)}</span></li>`;
    return `${list('queues', this.name, 'pick')}
      <div class="row"><input type="text" name="queueName" placeholder="${L('Name')}" value="${esc(this.name)}">${btn('save', 'save', 'SaveSet')}${btn('del', 'times', 'DeleteSet')}</div>
      <div class="cols">
        <div class="pane"><h3>${L('Sets')}</h3><ul>${names('sets').map((s) => `<li>${btn('add', 'plus', '', `data-set="${esc(s)}"`)} ${esc(s)}</li>`).join('') || `<li class="notes">${L('NoSets')}</li>`}</ul></div>
        <div class="pane"><h3>${L('QueueOrder')}</h3><ul>${this.list.map(item).join('') || `<li class="notes">${L('QueueEmpty')}</li>`}</ul></div>
      </div>`;
  }

  bind(root) { on(root, 'click', '[data-act]', (el) => this.act(el.dataset)); }

  /* List edits stay in memory until save. */
  act({ act, set, i, name }) {
    if (act === 'pick') { this.name = name; this.list = [...getQueue(name)]; return this.render(); }
    if (act === 'save' || act === 'del') return this[act]();
    i = Number(i);
    const swap = (j) => { [this.list[i], this.list[j]] = [this.list[j], this.list[i]]; };
    const ops = { add: () => !this.list.includes(set) && this.list.push(set), rm: () => this.list.splice(i, 1), up: () => i > 0 && swap(i - 1), down: () => i < this.list.length - 1 && swap(i + 1) };
    ops[act]?.(); this.render();
  }

  async store(fn) { const q = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'queues')); fn(q); await game.settings.set(MODULE_ID, 'queues', q); this.render(); this.parent?.render(); }

  async save() {
    const name = this.element.querySelector('input[name=queueName]').value.trim() || this.name;
    if (!name) return ui.notifications.warn(L('QueueNeedsName'));
    if (!this.list.length) return ui.notifications.warn(L('QueueEmpty'));
    this.name = name; say(`queue "${name}" saved (${this.list.join(' > ')})`);
    return this.store((q) => { q[name] = [...this.list]; });
  }

  async del() {
    const name = this.name;
    if (!name) return;
    this.name = ''; this.list = []; say(`queue "${name}" forgotten`);
    return this.store((q) => { delete q[name]; });
  }
}
