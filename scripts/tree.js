/* Folder tree discovery for packs and world. */
export const MODULE_ID = 'victory-lazy-loader';
export const TYPES = ['Actor', 'Scene', 'Playlist', 'JournalEntry', 'RollTable', 'Item', 'Macro']; /* unpack order */
export const L = (k) => game.i18n.localize(`VLL.${k}`);

export const parentOf = (f) => f._source?.folder ?? f.folder?.id ?? null;
const byName = (a, b) => a.name.localeCompare(b.name);
const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || byName(a, b);

/* Flat folders + docs into nested nodes. */
export function buildTree(folders, docs) {
  const nodes = new Map(), roots = [];
  for (const f of folders) nodes.set(f.id, { id: f.id, name: f.name, color: f.color?.css ?? f.color ?? null, sort: f.sort ?? 0, parent: parentOf(f), folders: [], docs: [] }); /* in: folders, out: node map */
  for (const n of nodes.values()) (n.parent && nodes.has(n.parent) ? nodes.get(n.parent).folders : roots).push(n); /* in: nodes, out: roots and children */
  for (const d of docs) nodes.get(d.folder?.id ?? d.folder ?? null)?.docs.push({ id: d._id ?? d.id, name: d.name }); /* in: docs, out: rootless skipped */
  for (const n of nodes.values()) { n.folders.sort(bySort); n.docs.sort(byName); } /* in: nodes, out: sorted lists */
  return roots.sort(bySort);
}

export const packsOf = (type) => game.packs.filter((p) => p.documentName === type);
export const homeOf = (type, id) => packsOf(type).find((p) => p.folders.has(id)) ?? null; /* pack owning folder id */
export const packWith = (type, ids) => packsOf(type).find((p) => ids.some((id) => p.index.has(id))) ?? null; /* pack owning any doc id */

/* Packs of a type that own folders. */
export async function packTrees(type) {
  const out = [];
  for (const pack of packsOf(type)) { /* in: each pack, out: trees collected */
    try { await pack.getIndex(); } catch (e) { throw new Error(`pack "${pack.collection}" index failed: ${e.message}`); } /* entry: fetch fails, exit: clear throw */
    if (!pack.folders.size) continue; /* in: pack, out: skip if no folders */
    out.push({ pack, tree: buildTree(pack.folders.contents, pack.index.contents) });
  }
  return out;
}

export const worldTree = (type) => buildTree(game.folders.filter((f) => f.type === type), game.collections.get(type).contents);

/* Flatten depth first, parents lead. */
export function flatten(roots) {
  const folders = [], docIds = [];
  const walk = (n) => { folders.push(n); docIds.push(...n.docs.map((d) => d.id)); n.folders.forEach(walk); }; /* gathers folders, doc ids */
  roots.forEach(walk); /* walk every root */
  return { folders, docIds };
}

/* Locate nodes by id anywhere in forest. */
export function findNodes(roots, ids) {
  const want = new Set(ids), hits = [];
  const walk = (n) => { if (want.has(n.id)) hits.push(n); else n.folders.forEach(walk); }; /* checked parent swallows children */
  roots.forEach(walk); /* collect matching nodes */
  return hits;
}

/* Name path survives id drift in sets. */
export function pathOf(roots, id) {
  const walk = (n, trail) => { const t = [...trail, n.name]; if (n.id === id) return t; for (const c of n.folders) { const r = walk(c, t); if (r) return r; } return null; }; /* name trail to id */
  for (const r of roots) { const p = walk(r, []); if (p) return p.join('/'); } /* in: roots, out: first path */
  return null;
}

export function idAtPath(roots, path) {
  let level = roots, hit = null;
  for (const name of path.split('/')) { hit = level.find((n) => n.name === name); if (!hit) return null; level = hit.folders; } /* in: path parts, out: id or null */
  return hit?.id ?? null;
}

export const deep = (n) => n.folders.reduce((a, c) => Math.max(a, 1 + deep(c)), 0); /* levels below node */
export const depthOf = (coll, id) => { let d = 0; for (let f = coll.get(id); f; f = coll.get(parentOf(f))) d++; return d; }; /* 1 = top level */
