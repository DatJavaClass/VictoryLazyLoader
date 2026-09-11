/* Job planner, progress bar, log. */
import { MODULE_ID, TYPES, L, packTrees, worldTree, findNodes, flatten, idAtPath, pathOf, depthOf, homeOf, packWith } from './tree.js';
import { unpack, repack, purge, tooDeep, WEIGHT } from './transfer.js';

export const LOG = [];
export const ACTS = { load: 'unpack', export: 'repack', unpack: 'unpack', repack: 'repack', validate: 'validate' }; /* 1.x verbs still answer */
const stamp = () => new Date().toTimeString().slice(0, 8);
const nav = () => foundry.applications?.ui?.SceneNavigation ?? globalThis.SceneNavigation; /* v13 namespaced, v12 global */
let prog = { done: 0, total: 0, label: '' };

/* Append line, echo to console and open window. */
export function say(msg) {
  LOG.push(`${stamp()} ${msg}`);
  console.log(`VLL | ${msg}`);
  const el = document.querySelector('#vll-app .log');
  if (el) { el.textContent = LOG.join('\n'); el.scrollTop = el.scrollHeight; }
}

/* Bar in the window and Foundry's own. */
export function progress(label, pct) {
  const el = document.querySelector('#vll-app .bar');
  if (el) { el.querySelector('span').style.width = `${pct}%`; el.querySelector('b').textContent = label; }
  try { nav()?.displayProgressBar?.({ label, pct }); } catch { /* bar is a courtesy */ }
}
const tick = (n) => { prog.done += n; progress(prog.label, Math.min(99, Math.floor(prog.done * 100 / Math.max(1, prog.total)))); };
const out = { say, tick };

/* Fresh trees for every type. */
export async function discover() {
  const data = {};
  for (const t of TYPES) data[t] = { packs: await packTrees(t), world: worldTree(t) };
  return data;
}

export const rootsOf = (data, type, side) => side === 'world' ? data[type].world : data[type].packs.find((e) => e.pack.collection === side)?.tree ?? [];

/* Members into per pack groups, both roots. */
export function resolve(data, members) {
  const groups = new Map();
  let miss = 0;
  for (const m of members) {
    const entry = data[m.type]?.packs.find((e) => e.pack.collection === m.pack), tree = entry?.tree ?? [];
    const id = findNodes(tree, [m.id]).length ? m.id : (m.path ? idAtPath(tree, m.path) : null); /* id first, path fallback */
    if (!entry || !id) { miss++; continue; }
    const k = `${m.type}|${m.pack}`, g = groups.get(k) ?? { type: m.type, pack: entry.pack, ids: [] };
    g.ids.push(id); groups.set(k, g);
  }
  const done = [...groups.values()].map((g) => ({ ...g, packRoots: findNodes(rootsOf(data, g.type, g.pack.collection), g.ids), worldRoots: findNodes(data[g.type].world, g.ids) }));
  return { groups: done, miss };
}

/* Ordered jobs; unpack and repack forward, validate reversed. */
export function plan(groups, act) {
  const order = act === 'validate' ? [...TYPES].reverse() : TYPES;
  const make = {
    unpack: (g) => ({ roots: g.packRoots, run: () => unpack(g.type, g.pack, g.packRoots, out), check: () => null }),
    repack: (g) => ({ roots: g.worldRoots, run: () => g.worldRoots.length ? repack(g.type, g.pack, g.worldRoots, out) : `${g.type}: no world copies`,
      check: () => tooDeep(g.worldRoots, (r) => g.pack.folders.has(r.id) ? depthOf(g.pack.folders, r.id) - 1 : 0, g.pack.maxFolderDepth ?? 3, g.pack.metadata.label) }),
    validate: (g) => ({ roots: g.worldRoots, run: () => g.worldRoots.length ? purge(g.type, g.pack, g.worldRoots, out) : `${g.type}: no world copies`, check: () => null }),
  };
  return order.flatMap((t) => groups.filter((g) => g.type === t).map((g) => { const j = make[act](g); return { ...j, type: g.type, label: `${L(act)} ${g.type}`, cost: flatten(j.roots).docIds.length * WEIGHT[act] }; }));
}

/* Pre flight every job, then run. */
export async function run(queue, label) {
  if (!queue.length) { say(`${label}: nothing to do`); return false; }
  const halt = queue.map((j) => j.check()).filter(Boolean);
  if (halt.length) { halt.forEach((h) => say(`HALT ${h}`)); ui.notifications.error(`VLL: ${halt[0]}`); return false; }
  say(`${label}: ${queue.length} job(s)`);
  prog = { done: 0, total: queue.reduce((a, j) => a + j.cost, 0), label };
  const note = ui.notifications.warn(L('Busy'), { permanent: true }), touched = new Set();
  try { for (const j of queue) { prog.label = j.label; tick(0); touched.add(j.type); say(await j.run()); } say(`${label}: done`); return true; }
  catch (e) { say(`ERROR ${e.message}`); console.error(e); return false; }
  finally {
    progress(`${label}: done`, 100);
    try { ui.notifications.remove(note); } catch { /* v13 takes the object, v12 the id */ }
    say(`redrawing sidebar: ${[...touched].join(', ')}`);
    for (const t of touched) { try { game.collections.get(t).render(false); } catch { /* directory redraw only */ } }
    if (touched.has('Scene')) { try { ui.nav?.render(false); } catch { /* same */ } }
    say('sidebar redrawn');
  }
}

/* Saved set by name, or throw. */
export function getSet(name) {
  const set = game.settings.get(MODULE_ID, 'sets')[name];
  if (!set) throw new Error(`no saved set "${name}"`);
  return set;
}

/* Run one action over a saved set. */
export async function runSet(name, act, data = null) {
  act = ACTS[act] ?? act;
  const set = getSet(name), d = data ?? await discover(), { groups, miss } = resolve(d, set.members ?? []);
  if (miss) say(`set "${name}": ${miss} member(s) not found`);
  const ok = await run(plan(groups, act), `${L(act)} "${name}"`);
  Hooks.callAll('vll.done', { set: name, act, ok });
  return ok;
}

/* Saved queue by name, or throw. */
export function getQueue(name) {
  const q = game.settings.get(MODULE_ID, 'queues')[name];
  if (!q) throw new Error(`no saved queue "${name}"`);
  return q;
}

/* Sets front to back; halt on failure. */
export async function runQueue(name, act) {
  act = ACTS[act] ?? act;
  const names = getQueue(name), sets = game.settings.get(MODULE_ID, 'sets'), miss = names.filter((n) => !sets[n]);
  if (miss.length) { say(`queue "${name}": missing set(s) ${miss.join(', ')}`); return false; }
  say(`queue "${name}": ${L(act)} ${names.length} set(s)`);
  let ok = true;
  for (const n of names) if (!(ok = await runSet(n, act))) { say(`queue "${name}": halted at "${n}"`); break; }
  if (ok) say(`queue "${name}": done`);
  Hooks.callAll('vll.queueDone', { queue: name, act, ok });
  return ok;
}

/* Repack and purge X, then unpack Y. */
export async function swap(outName, inName) {
  if (outName) { if (!await runSet(outName, 'repack')) return false; if (!await runSet(outName, 'validate')) return false; }
  return inName ? runSet(inName, 'unpack') : true;
}

/* 1.x rows and 2.0 dests become members. */
export async function migrate() {
  const sets = game.settings.get(MODULE_ID, 'sets'), old = Object.entries(sets).filter(([, s]) => s.rows || s.dest);
  if (!old.length) return;
  const data = await discover(), next = foundry.utils.deepClone(sets);
  for (const [name, s] of old) {
    const members = new Map();
    for (const r of s.rows ?? s.members) {
      const pack = r.pack ?? (r.side !== 'world' ? r.side : (homeOf(r.type, r.id) ?? packWith(r.type, flatten(findNodes(data[r.type].world, [r.id])).docIds))?.collection);
      if (!pack) continue;
      members.set(`${r.type}|${pack}|${r.id}`, { type: r.type, pack, id: r.id, path: pathOf(rootsOf(data, r.type, pack), r.id) ?? r.path ?? null });
    }
    next[name] = { members: [...members.values()] };
    say(`set "${name}" migrated: ${members.size} member(s)`);
  }
  await game.settings.set(MODULE_ID, 'sets', next);
}
