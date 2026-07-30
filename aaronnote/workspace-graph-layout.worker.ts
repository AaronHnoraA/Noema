type LayoutNode = { key: string; x: number; y: number; current?: boolean; vx?: number; vy?: number };
type LayoutEdge = { source: string; target: string };

self.addEventListener("message", (event: MessageEvent<{
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  maxTicks?: number;
}>) => {
  const { width, height } = event.data;
  const nodes = event.data.nodes.slice(0, 1_500).map((node) => ({ ...node, vx: 0, vy: 0 }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const edges = event.data.edges.slice(0, 25_000)
    .map((edge) => ({ source: byKey.get(edge.source), target: byKey.get(edge.target) }))
    .filter((edge): edge is { source: LayoutNode; target: LayoutNode } => Boolean(edge.source && edge.target));
  const started = performance.now();
  const ticks = Math.min(240, Math.max(1, event.data.maxTicks ?? 240));

  for (let tick = 0; tick < ticks && performance.now() - started < 1_900; tick += 1) {
    const alpha = 0.08 * (1 - tick / ticks) + 0.005;
    for (const edge of edges) {
      const dx = edge.target.x - edge.source.x || 0.01;
      const dy = edge.target.y - edge.source.y || 0.01;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 72) / distance * alpha * 0.035;
      edge.source.vx! += dx * force;
      edge.source.vy! += dy * force;
      edge.target.vx! -= dx * force;
      edge.target.vy! -= dy * force;
    }
    for (const node of nodes) {
      const centering = node.current ? 0.035 : 0.0025;
      node.vx! += (width / 2 - node.x) * centering * alpha;
      node.vy! += (height / 2 - node.y) * centering * alpha;
      node.x = Math.max(12, Math.min(width - 12, node.x + node.vx!));
      node.y = Math.max(12, Math.min(height - 12, node.y + node.vy!));
      node.vx! *= 0.84;
      node.vy! *= 0.84;
    }
  }
  self.postMessage({ positions: nodes.map(({ key, x, y }) => ({ key, x, y })) });
});

export {};
