/* Unpack, repack, and purge engines. */
import { MODULE_ID, flatten, parentOf, deep, depthOf, worldTree, pathOf, idAtPath } from './tree.js';

const FLAG = `flags.${MODULE_ID}.loaded`, HOME = `flags.${MODULE_ID}.home`, CHUNK = { Scene: 10, Actor: 25 }, KEEP = { keepId: true, clearFolder: false, clearOwnership: false, clearSort: false, clearPrototypeToken: false };
export const WEIGHT = { unpack: 3, repack: 2, validate: 1 }; /* writes per doc, feeds the bar */
const cls = (type) => CONFIG[type].documentClass;
const bare = (name) => name.replace(/!+$/, '');
const quiet = (opts = {}) => ({ render: false, ...opts }); /* sidebar redraws once, after the run */
const batch = async (arr, type, fn, out) => { const n = CHUNK[type] ?? 50; for (let i = 0; i < arr.length; i += n) { await fn(arr.slice(i, i + n)); out?.tick(Math.min(n, arr.length - i)); } }; /* chunked sequential writes */

/* Unlock, run, relock per setting. */
async function unlocked(pack, fn) {
  const was = pack.locked;
  if (was) await pack.configure({ locked: false });
  try { return await fn(); }
  finally { if (was && game.settings.get(MODULE_ID, 'relock')) await pack.configure({ locked: true }); }
}

/* Missing folders, parents first, keepId. */
async function ensureFolders(type, folders, existing, place, pack = null) {
  const inSet = (id) => folders.some((p) => p.id === id), top = (n) => !(n.parent && inSet(n.parent));
  const missing = folders.filter((n) => !existing.has(n.id)).map((n) => ({ _id: n.id, name: n.name, type, folder: top(n) ? place(n) : n.parent, color: n.color, sorting: 'a' }));
  await batch(missing, 'Folder', (part) => cls('Folder').createDocuments(part, quiet({ keepId: true, ...(pack ? { pack } : {}) })));
  return missing.length;
}

/* Remembered world parent, else Root. */
function landing(type, pack, n, out) {
  const home = pack.folders.get(n.id)?.getFlag(MODULE_ID, 'home')?.[game.world.id];
  if (!home?.parent) return null;
  const id = game.folders.has(home.parent) ? home.parent : (home.path ? idAtPath(worldTree(type), home.path) : null);
  const why = !id ? 'remembered parent is gone' : depthOf(game.folders, id) + 1 + deep(n) > (CONST.FOLDER_MAX_DEPTH ?? 4) ? 'remembered parent sits too deep' : null;
  if (why) { out.say(`  "${n.name}": ${why}, landing at Root`); return null; }
  return id;
}

/* Stamp world parent on pack folder. */
async function remember(pack, roots, type) {
  const tree = worldTree(type), rows = roots.filter((r) => pack.folders.has(r.id)).map((r) => ({ _id: r.id, [`${HOME}.${game.world.id}`]: { parent: r.parent ?? null, path: r.parent ? pathOf(tree, r.parent) : null } }));
  if (rows.length) await cls('Folder').updateDocuments(rows, quiet({ pack: pack.collection }));
  return rows.length;
}

/* Scene links aimed at missing scenes. */
export function audit(type, datas, coll, out, when) {
  if (type !== 'Scene') return;
  const have = new Set(datas.map((d) => d._id ?? d.id)), re = /"scene(?:Id)?":"([A-Za-z0-9]{16})"|Scene\.([A-Za-z0-9]{16})/g;
  for (const s of datas) {
    const miss = new Set();
    for (const m of JSON.stringify([s.flags, (s.tiles ?? []).map((t) => t.flags)]).matchAll(re)) { const id = m[1] ?? m[2]; if (!have.has(id) && !coll.has(id)) miss.add(id); }
    if (miss.size) out.say(`  ${when} "${bare(s.name)}": ${miss.size} link(s) to missing scenes`);
  }
}

/* Delete then create by id, flags intact. */
async function replace(type, datas, out, opts = {}) {
  const coll = opts.pack ? game.packs.get(opts.pack).index : game.collections.get(type), ids = datas.map((d) => d._id);
  const stale = ids.filter((id) => coll.has(id));
  const live = !opts.pack && type === 'Scene' ? { active: game.scenes.active?.id, view: canvas.scene?.id } : {}; /* restore after replace */
  await batch(stale, type, (part) => cls(type).deleteDocuments(part, quiet(opts)), out);
  await batch(datas, type, (part) => cls(type).createDocuments(part, quiet({ keepId: true, ...opts })), out);
  if (ids.includes(live.active)) await game.scenes.get(live.active).activate();
  if (ids.includes(live.view)) await game.scenes.get(live.view).view();
  return { created: datas.length - stale.length, replaced: stale.length };
}

const strip = (x) => { x.name = bare(x.name); delete x.flags?.[MODULE_ID]; if (x.sounds) { x.playing = false; x.sounds.forEach((s) => (s.playing = false)); } return x; };

/* Pack subtree to world, then mark pack. */
export async function unpack(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type), spot = new Map(roots.map((r) => [r.id, landing(type, pack, r, out)]));
  const nf = await ensureFolders(type, folders, game.folders, (n) => spot.get(n.id) ?? null);
  if (!docIds.length) return `${type}: ${nf} folders made, no documents`;
  out.say(`${type}: fetching ${docIds.length} from ${pack.metadata.label}`);
  const docs = await pack.getDocuments({ _id__in: docIds }), datas = docs.map((d) => strip(coll.fromCompendium(d, KEEP)));
  audit(type, datas, coll, out, 'before');
  const r = await replace(type, datas, out);
  audit(type, docIds.map((id) => coll.get(id)?.toObject()).filter(Boolean), coll, out, 'after');
  out.say(`${type}: marking ${docs.length} in ${pack.metadata.label}`);
  const stamp = { time: Date.now(), world: game.world.id };
  await unlocked(pack, () => batch(docs, type, (part) => cls(type).updateDocuments(part.map((d) => ({ _id: d.id, name: `${bare(d.name)}!`, [FLAG]: stamp })), { pack: pack.collection }), out));
  out.say(`${type}: pack relocked`);
  return `${type}: ${r.created} created, ${r.replaced} replaced, ${nf} folders made`;
}

/* World subtree home by id, placement remembered. */
export async function repack(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type);
  out.say(`${type}: repacking ${docIds.length} to ${pack.metadata.label}`);
  const datas = docIds.map((id) => coll.get(id)).filter(Boolean).map((d) => strip(d.toCompendium(pack, KEEP)));
  audit(type, datas, pack.index, out, 'before');
  return unlocked(pack, async () => {
    const nf = await ensureFolders(type, folders, pack.folders, () => null, pack.collection);
    const nh = await remember(pack, roots, type);
    const r = datas.length ? await replace(type, datas, out, { pack: pack.collection }) : { created: 0, replaced: 0 };
    await pack.getIndex();
    return `${type}: ${r.created} created, ${r.replaced} replaced, ${nf} folders made, ${nh} placement(s) remembered`;
  });
}

/* Pack copy newer and unmarked = safe. */
async function validate(type, pack, docIds) {
  const packDocs = await pack.getDocuments({ _id__in: docIds }), coll = game.collections.get(type), ok = [], bad = [];
  for (const id of docIds) {
    const w = coll.get(id), p = packDocs.find((d) => d.id === id);
    const marked = /!$/.test(p?.name ?? '') || !!p?.getFlag(MODULE_ID, 'loaded');
    const fresh = (p?._stats?.modifiedTime ?? 0) >= (w._stats?.modifiedTime ?? 0);
    (p && !marked && fresh ? ok : bad).push(id);
  }
  return { ok, bad };
}

/* Delete validated world copies, remember placement. */
export async function purge(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type), v = await validate(type, pack, docIds.filter((id) => coll.has(id))), ids = v.ok, skipped = v.bad.length;
  const nh = await unlocked(pack, () => remember(pack, roots, type));
  out.say(`${type}: deleting ${ids.length}${skipped ? `, keeping ${skipped} unsynced` : ''}, ${nh} placement(s) remembered`);
  await batch(ids, type, (part) => cls(type).deleteDocuments(part, quiet()), out);

  /* Prune emptied pack held folders, children first. */
  let nf = 0;
  for (const n of [...folders].reverse()) {
    const f = game.folders.get(n.id);
    if (!f || f.contents.length || game.folders.some((c) => parentOf(c) === f.id) || !pack.folders.has(f.id)) continue;
    await f.delete({ deleteSubfolders: false, deleteContents: false, render: false }); nf++;
  }
  return `${type}: ${ids.length} deleted, ${skipped} kept, ${nf} folders pruned`;
}

/* Halt text when a tree exceeds cap. */
export const tooDeep = (roots, baseOf, cap, side) => { for (const r of roots) { const d = baseOf(r) + 1 + deep(r); if (d > cap) return `"${r.name}" would sit ${d} deep, ${side} allows ${cap}`; } return null; };
