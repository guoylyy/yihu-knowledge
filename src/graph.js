// 边只算双链；md 链接只计入 inbound，让「被引用次数」与阅读页的反向链接一致。想把 md 也画成边，改这一行
const EDGE_KINDS = "'wiki', 'embed'";

const topDir = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '');

export function createGraph({ db, catalog, allow }) {
  const links = db.prepare(`SELECT src_id AS source, target_id AS target, MAX(kind IN (${EDGE_KINDS})) AS drawn
                            FROM links
                            WHERE kind IN ('wiki', 'embed', 'md') AND target_id IS NOT NULL AND src_id != target_id
                            GROUP BY src_id, target_id`);

  return function graphData() {
    const byId = new Map();
    for (const f of catalog.snapshot.rows) {
      if (!allow(f)) continue;
      byId.set(f.id, { id: f.id, path: f.path, title: f.title || f.name, dir: topDir(f.path), degree: 0, inbound: 0, sensitive: f.is_sensitive });
    }
    const edges = [];
    for (const { source, target, drawn } of links.all()) {
      const from = byId.get(source);
      const to = byId.get(target);
      if (!from || !to) continue;
      to.inbound++;
      if (!drawn) continue;
      from.degree++;
      to.degree++;
      edges.push({ source, target });
    }
    const nodes = [...byId.values()];
    const linked = nodes.filter((n) => n.degree > 0).length;
    return { nodes, edges, stats: { nodes: nodes.length, linked, edges: edges.length, isolated: nodes.length - linked } };
  };
}
