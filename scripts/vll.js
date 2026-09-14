/* Settings, sidebar button, and module API. */
import { MODULE_ID, TYPES, L } from './tree.js';
import { LazyLoaderApp } from './app.js';
import { LOG, ACTS, say, discover, resolve, plan, run, runSet, runQueue, swap, migrate } from './runner.js';

let app = null;
const open = () => (app ??= new LazyLoaderApp()).render(true);
const gm = () => { if (!game.user.isGM) throw new Error('VLL: GM only'); };

/* Folder names per type and side, for callers. */
async function list() {
  const data = await discover(), dump = (n, d) => [`${'  '.repeat(d)}${n.name} (${n.docs.length})`, ...n.folders.map((c) => dump(c, d + 1))].join('\n');
  const out = {};
  for (const t of TYPES) out[t] = { packs: Object.fromEntries(data[t].packs.map((e) => [e.pack.collection, e.tree.map((n) => dump(n, 0)).join('\n')])), world: data[t].world.map((n) => dump(n, 0)).join('\n') };
  return out;
}

/* One action over ad hoc members. */
async function act(action, members) {
  gm();
  const { groups, miss } = resolve(await discover(), members.map((m) => ({ ...m, id: m.id ?? '' })));
  if (miss) say(`api ${action}: ${miss} member(s) not found`);
  return run(plan(groups, ACTS[action]), `api ${action}`);
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'sets', { scope: 'world', config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, 'queues', { scope: 'world', config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, 'relock', { name: 'VLL.SETTINGS.Relock.Name', hint: 'VLL.SETTINGS.Relock.Hint', scope: 'world', config: true, type: Boolean, default: true });
  game.settings.register(MODULE_ID, 'mirror', { name: 'VLL.SETTINGS.Mirror.Name', hint: 'VLL.SETTINGS.Mirror.Hint', scope: 'world', config: true, type: Boolean, default: true });
});

/* Module API, load/export = 1.x aliases. */
Hooks.once('ready', async () => {
  if (!game.user.isGM) return;
  await migrate();
  game.modules.get(MODULE_ID).api = {
    open, list, LOG, TYPES,
    sets: () => Object.keys(game.settings.get(MODULE_ID, 'sets')),
    queues: () => Object.keys(game.settings.get(MODULE_ID, 'queues')),
    runSet: (name, action) => { gm(); return runSet(name, action); },
    runQueue: (name, action) => { gm(); return runQueue(name, action); },
    swap: (outName, inName) => { gm(); return swap(outName, inName); },
    unpack: (members) => act('unpack', members), load: (members) => act('unpack', members),
    repack: (members) => act('repack', members), export: (members) => act('repack', members),
    validate: (members) => act('validate', members),
  };
  Hooks.callAll('vll.ready', game.modules.get(MODULE_ID).api);
});

/* Compendium sidebar button, GM only. */
Hooks.on('renderCompendiumDirectory', (dir, html) => {
  if (!game.user.isGM) return;
  const el = html instanceof HTMLElement ? html : html[0], host = el.querySelector('.directory-header .header-actions') ?? el.querySelector('.directory-header .action-buttons') ?? el.querySelector('.directory-header') ?? el; /* v12 jQuery, v13 element */
  if (host.querySelector('.vll-open')) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'vll-open'; b.innerHTML = `<i class="fas fa-truck-loading"></i> ${L('Open')}`;
  b.addEventListener('click', open);
  host.append(b);
});
