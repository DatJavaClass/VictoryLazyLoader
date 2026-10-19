/* Unpack, repack, and purge engines. */
import { MODULE_ID, flatten, parentOf, deep, depthOf, worldTree, pathOf, idAtPath } from './tree.js';

const FLAG = `flags.${MODULE_ID}.loaded`; /* pack mark */
const HOME = `flags.${MODULE_ID}.home`; /* remembered parent */
const CHUNK = { Scene: 10, Actor: 25 }; /* batch sizes */
const KEEP = { keepId: true, clearFolder: false, clearOwnership: false, clearSort: false, clearPrototypeToken: false }; /* compendium conversion */

export const WEIGHT = { unpack: 3, repack: 2, validate: 1 }; /* writes per doc, feeds the bar */
const cls = (type) => CONFIG[type].documentClass;
const bare = (name) => name.replace(/!+$/, '');
const quiet = (opts = {}) => ({ render: false, ...opts }); /* redraw once after */
const batch = async (arr, type, fn, out) => { const n = CHUNK[type] ?? 50; for (let i = 0; i < arr.length; i += n) { await fn(arr.slice(i, i + n)); out?.tick(Math.min(n, arr.length - i)); } }; /* in: array, out: written */

/* Unlock, run, relock per setting. */
async function unlocked(pack, fn) {
  const was = pack.locked;
  if (was) await pack.configure({ locked: false }); /* in: pack, out: unlocked if locked */
  try { return await fn(); }
  finally { if (was && game.settings.get(MODULE_ID, 'relock')) await pack.configure({ locked: true }); } /* in: was, out: relock per setting */
}

/* Missing folders, parents first, keepId. */
async function ensureFolders(type, folders, existing, place, pack = null, rename = new Map()) {
  const inSet = (id) => folders.some((p) => p.id === id), top = (n) => !(n.parent && inSet(n.parent));
  const missing = folders.filter((n) => !existing.has(n.id)).map((n) => ({ _id: n.id, name: rename.get(n.id) ?? n.name, type, folder: top(n) ? place(n) : n.parent, color: n.color, sorting: 'a' })); /* in: folders, out: creates */
  await batch(missing, 'Folder', (part) => cls('Folder').createDocuments(part, quiet({ keepId: true, ...(pack ? { pack } : {}) })));
  return missing.length;
}

/* Pack ancestors of n, top first. */
const lineage = (pack, n) => { const out = []; for (let f = pack.folders.get(n.id)?.folder; f; f = f.folder) out.unshift(f); return out; }; /* ancestors, top first */
const CITY = /^(.+?)_(.+)([$@])$/; /* City_District$ merchants, City_District@ POI */
const cap = () => CONST.FOLDER_MAX_DEPTH ?? 4;

/* World only folder by name, label flagged. */
async function bucket(type, pack, name, parent) {
  let w = game.folders.find((x) => x.type === type && x.name === name && parentOf(x) === parent);
  if (!w) [w] = await cls('Folder').createDocuments([{ name, type, folder: parent, sorting: 'a', flags: { [MODULE_ID]: { label: pack.collection } } }], quiet()); /* in: name, out: made if absent */
  return w.id;
}

/* World copy of pack path, label on top. */
async function mirror(type, pack, n, out) {
  const chain = [{ name: pack.metadata.label }, ...lineage(pack, n).map((f) => ({ id: f.id, name: f.name, color: f.color?.css ?? null }))]; /* pack path chain */
  if (chain.length + 1 + deep(n) > cap()) { out.say(`  "${n.name}": pack path too deep to mirror, landing at Root`); return null; } /* in: chain, out: Root if too deep */
  let parent = null;
  for (const f of chain) { /* in: chain link; out: parent id */
    let w = (f.id && game.folders.get(f.id)) || game.folders.find((x) => x.type === type && x.name === f.name && parentOf(x) === parent); /* id first, then name */
    if (!w) [w] = await cls('Folder').createDocuments([{ ...(f.id ? { _id: f.id } : { flags: { [MODULE_ID]: { label: pack.collection } } }), name: f.name, type, folder: parent, color: f.color ?? null, sorting: 'a' }], quiet({ keepId: !!f.id })); /* in: link, out: made if absent */
    parent = w.id;
  }
  return parent;
}

/* Actors: region roots, Merchants and POI buckets. */
async function region(type, pack, n, out) {
  const path = [...lineage(pack, n).map((f) => ({ id: f.id, name: f.name, color: f.color?.css ?? null })), n], top = path[0], m = CITY.exec(top.name); /* pack path, city match */
  const root = (name) => bucket(type, pack, name, null), rename = new Map();
  let parent = null, rest = path.slice(1);
  if (m) parent = await bucket(type, pack, m[3] === '$' ? 'Merchants' : 'POI', await root(m[1])); /* in: city match, out: bucket parent */
  else if (top.name === 'Commission' && /_Branch$/.test(path[1]?.name ?? '')) { parent = await root(path[1].name.replace(/_Branch$/, '')); rename.set(path[1].id, 'Commission'); } /* in: Commission, out: branch root */
  else if (top.name === 'Principalities' && path[1]) { parent = await root(path[1].name); rename.set(path[1].id, 'Principalities'); } /* in: Principalities, out: region root */
  else if (path.length === 1) return n.docs.length || !n.folders.length ? { parent: null } : { parent: await root(n.name), skip: true }; /* in: top folder, out: Root or region bucket */
  else parent = await root(top.name); /* in: fallthrough, out: top name root */
  if (path.length === 1) return n.docs.length ? { parent } : { parent, skip: true }; /* in: single path, out: keep or skip */
  for (const f of rest.slice(0, -1)) { /* in: mid folders; out: parent set */
    let w = game.folders.get(f.id);
    if (!w) [w] = await cls('Folder').createDocuments([{ _id: f.id, name: rename.get(f.id) ?? f.name, type, folder: parent, color: f.color, sorting: 'a' }], quiet({ keepId: true })); /* in: mid folder, out: made if absent */
    parent = w.id;
  }
  return { parent, rename: rename.get(n.id) ?? null };
}

/* Remembered parent, else layout, else Root. */
async function landing(type, pack, n, out) {
  const home = pack.folders.get(n.id)?.getFlag(MODULE_ID, 'home')?.[game.world.id];
  const fresh = () => game.settings.get(MODULE_ID, 'mirror') ? type === 'Actor' ? region(type, pack, n, out) : mirror(type, pack, n, out).then((parent) => ({ parent })) : { parent: null }; /* layout landing resolver */
  if (!home?.parent) return fresh(); /* in: no remembered parent, out: layout */
  const id = game.folders.has(home.parent) ? home.parent : (home.path ? idAtPath(worldTree(type), home.path) : null); /* remembered parent, else path */
  if (!id) { out.say(`  "${n.name}": remembered parent is gone, landing by layout`); return fresh(); } /* in: id, out: layout if gone */
  if (depthOf(game.folders, id) + 1 + deep(n) > cap()) { out.say(`  "${n.name}": remembered parent sits too deep, landing at Root`); return { parent: null }; } /* in: depth, out: Root if too deep */
  return { parent: id };
}

/* Stamp world parent on pack folder. */
async function remember(pack, roots, type) {
  const tree = worldTree(type), rows = roots.filter((r) => pack.folders.has(r.id)).map((r) => ({ _id: r.id, [`${HOME}.${game.world.id}`]: { parent: r.parent ?? null, path: r.parent ? pathOf(tree, r.parent) : null } })); /* placement rows to stamp */
  if (rows.length) await cls('Folder').updateDocuments(rows, quiet({ pack: pack.collection })); /* in: rows, out: update if any */
  return rows.length;
}

/* Scene links aimed at missing scenes. */
export function audit(type, datas, coll, out, when) {
  if (type !== 'Scene') return; /* in: type, out: Scene only */
  const have = new Set(datas.map((d) => d._id ?? d.id)), re = /"scene(?:Id)?":"([A-Za-z0-9]{16})"|Scene\.([A-Za-z0-9]{16})/g; /* existing ids, link regex */
  for (const s of datas) { /* in: scene, out: missing links logged */
    const miss = new Set();
    for (const m of JSON.stringify([s.flags, (s.tiles ?? []).map((t) => t.flags)]).matchAll(re)) { const id = m[1] ?? m[2]; if (!have.has(id) && !coll.has(id)) miss.add(id); } /* in: matches, out: missing ids set */
    if (miss.size) out.say(`  ${when} "${bare(s.name)}": ${miss.size} link(s) to missing scenes`); /* in: misses, out: log if any */
  }
}

/* Delete then create by id, flags intact. */
async function replace(type, datas, out, opts = {}) {
  const coll = opts.pack ? game.packs.get(opts.pack).index : game.collections.get(type), ids = datas.map((d) => d._id); /* target collection, doc ids */
  const stale = ids.filter((id) => coll.has(id)); /* ids already present */
  const live = !opts.pack && type === 'Scene' ? { active: game.scenes.active?.id, view: canvas.scene?.id } : {}; /* in: type, out: ids */
  await batch(stale, type, (part) => cls(type).deleteDocuments(part, quiet(opts)), out);
  await batch(datas, type, (part) => cls(type).createDocuments(part, quiet({ keepId: true, ...opts })), out);
  if (ids.includes(live.active)) await game.scenes.get(live.active).activate(); /* in: ids, out: scene reactivated */
  if (ids.includes(live.view)) await game.scenes.get(live.view).view(); /* in: view id, out: view restored */
  return { created: datas.length - stale.length, replaced: stale.length };
}

const strip = (x) => { x.name = bare(x.name); delete x.flags?.[MODULE_ID]; if (x.sounds) { x.playing = false; x.sounds.forEach((s) => (s.playing = false)); } return x; }; /* strip marks, stop sounds */

/* Pack subtree to world, then mark pack. */
export async function unpack(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type), spot = new Map(), skip = new Set(), rename = new Map();
  for (const r of roots) { /* in: root; out: spot or skip */
    const l = await landing(type, pack, r, out);
    if (l.skip) { skip.add(r.id); r.folders.forEach((c) => spot.set(c.id, l.parent)); } /* in: skip, out: children take spot */
    else { spot.set(r.id, l.parent); if (l.rename) rename.set(r.id, l.rename); } /* in: landing, out: spot, rename set */
  }
  const nf = await ensureFolders(type, folders.filter((n) => !skip.has(n.id)), game.folders, (n) => spot.get(n.id) ?? null, null, rename);
  if (!docIds.length) return `${type}: ${nf} folders made, no documents`; /* in: docIds, out: early return */
  out.say(`${type}: fetching ${docIds.length} from ${pack.metadata.label}`);
  const docs = await pack.getDocuments({ _id__in: docIds }), datas = docs.map((d) => strip(coll.fromCompendium(d, KEEP))); /* fetched docs, stripped data */
  audit(type, datas, coll, out, 'before');
  const r = await replace(type, datas, out);
  audit(type, docIds.map((id) => coll.get(id)?.toObject()).filter(Boolean), coll, out, 'after'); /* world copies after replace */
  out.say(`${type}: marking ${docs.length} in ${pack.metadata.label}`);
  const stamp = { time: Date.now(), world: game.world.id };
  await unlocked(pack, () => batch(docs, type, (part) => cls(type).updateDocuments(part.map((d) => ({ _id: d.id, name: `${bare(d.name)}!`, [FLAG]: stamp })), { pack: pack.collection }), out)); /* mark pack copies as loaded */
  out.say(`${type}: pack relocked`);
  return `${type}: ${r.created} created, ${r.replaced} replaced, ${nf} folders made`;
}

/* World subtree home by id, placement remembered. */
export async function repack(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type);
  out.say(`${type}: repacking ${docIds.length} to ${pack.metadata.label}`);
  const datas = docIds.map((id) => coll.get(id)).filter(Boolean).map((d) => strip(d.toCompendium(pack, KEEP))); /* stripped compendium data */
  audit(type, datas, pack.index, out, 'before');
  return unlocked(pack, async () => {
    const nf = await ensureFolders(type, folders, pack.folders, () => null, pack.collection);
    const nh = await remember(pack, roots, type);
    const r = datas.length ? await replace(type, datas, out, { pack: pack.collection }) : { created: 0, replaced: 0 }; /* replace, else zeros */
    await pack.getIndex();
    return `${type}: ${r.created} created, ${r.replaced} replaced, ${nf} folders made, ${nh} placement(s) remembered`;
  });
}

/* Pack copy newer and unmarked = safe. */
async function validate(type, pack, docIds) {
  const packDocs = await pack.getDocuments({ _id__in: docIds }), coll = game.collections.get(type), ok = [], bad = [];
  for (const id of docIds) { /* in: id, out: ok or bad */
    const w = coll.get(id), p = packDocs.find((d) => d.id === id);
    const marked = /!$/.test(p?.name ?? '') || !!p?.getFlag(MODULE_ID, 'loaded');
    const fresh = (p?._stats?.modifiedTime ?? 0) >= (w._stats?.modifiedTime ?? 0);
    (p && !marked && fresh ? ok : bad).push(id); /* in: copy state, out: ok or bad */
  }
  return { ok, bad };
}

/* Delete validated world copies, remember placement. */
export async function purge(type, pack, roots, out) {
  const { folders, docIds } = flatten(roots), coll = game.collections.get(type), v = await validate(type, pack, docIds.filter((id) => coll.has(id))), ids = v.ok, skipped = v.bad.length; /* validated ids, kept count */
  const nh = await unlocked(pack, () => remember(pack, roots, type));
  out.say(`${type}: deleting ${ids.length}${skipped ? `, keeping ${skipped} unsynced` : ''}, ${nh} placement(s) remembered`); /* in: skipped, out: log suffix */
  await batch(ids, type, (part) => cls(type).deleteDocuments(part, quiet()), out);

  /* Prune empty folders, children then ancestors. */
  let nf = 0;
  const empty = (f) => !f.contents.length && !game.folders.some((c) => parentOf(c) === f.id), mine = (f) => pack.folders.has(f.id) || !!f.getFlag(MODULE_ID, 'label');
  const drop = async (f) => { await f.delete({ deleteSubfolders: false, deleteContents: false, render: false }); nf++; };
  for (const n of [...folders].reverse()) { const f = game.folders.get(n.id); if (f && empty(f) && mine(f)) await drop(f); } /* in: folders, out: empty ones dropped */
  for (const r of roots) for (let f = game.folders.get(r.parent); f && empty(f) && mine(f); f = game.folders.get(parentOf(f))) await drop(f); /* in: roots, out: ancestors pruned */
  return `${type}: ${ids.length} deleted, ${skipped} kept, ${nf} folders pruned`;
}

/* Halt text when a tree exceeds cap. */
export const tooDeep = (roots, baseOf, max, side) => { for (const r of roots) { const d = baseOf(r) + 1 + deep(r); if (d > max) return `"${r.name}" would sit ${d} deep, ${side} allows ${max}`; } return null; }; /* in: roots, out: halt text or null */
