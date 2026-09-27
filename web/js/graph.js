/**
 * Layered DAG rendering.
 *
 * Nodes are placed in columns by *longest-path depth*, not by insertion order.
 * That choice does real work: in a longest-path layering every edge necessarily
 * points from a lower layer to a higher one, so all arrows run left to right and
 * the absence of a backward arrow is visible proof the graph is acyclic. A
 * force-directed layout would look livelier and show none of that.
 *
 * Hand-rolled SVG rather than a graph library: the layout is thirty lines, and
 * a dependency for thirty lines is a poor trade.
 */

import { clear } from './dom.js';

const NODE_W = 168;
const NODE_H = 62;
const GAP_X = 96;
const GAP_Y = 22;
const PAD = 28;

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/**
 * Longest-path layering. Layer(v) = 0 for a source, else 1 + max(layer(preds)).
 * @param {any[]} tasks
 * @param {any[]} deps
 */
export function layerNodes(tasks, deps) {
  const incoming = new Map(tasks.map((t) => [t.id, []]));
  const outDegree = new Map(tasks.map((t) => [t.id, 0]));
  for (const d of deps) {
    if (!incoming.has(d.successorId) || !incoming.has(d.predecessorId)) continue;
    incoming.get(d.successorId).push(d.predecessorId);
    outDegree.set(d.predecessorId, (outDegree.get(d.predecessorId) ?? 0) + 1);
  }

  const layer = new Map();
  // Iterative relaxation over a topological order. The server guarantees the
  // graph is a DAG, but the loop is bounded by node count anyway so a corrupted
  // payload cannot hang the tab.
  let changed = true;
  let guard = tasks.length + 1;
  for (const t of tasks) layer.set(t.id, 0);
  while (changed && guard-- > 0) {
    changed = false;
    for (const t of tasks) {
      const preds = incoming.get(t.id) ?? [];
      const want = preds.length === 0 ? 0 : Math.max(...preds.map((p) => (layer.get(p) ?? 0) + 1));
      if (want !== layer.get(t.id)) {
        layer.set(t.id, want);
        changed = true;
      }
    }
  }
  return layer;
}

/**
 * @param {HTMLElement} host
 * @param {{ tasks: any[], dependencies: any[] }} board
 * @param {{ criticalOnly: boolean, onSelect: (task: any) => void }} options
 */
export function renderGraph(host, board, options) {
  clear(host);

  let tasks = board.tasks;
  let deps = board.dependencies;
  if (options.criticalOnly) {
    tasks = tasks.filter((t) => t.isCritical);
    const visible = new Set(tasks.map((t) => t.id));
    deps = deps.filter((d) => visible.has(d.predecessorId) && visible.has(d.successorId));
  }

  if (tasks.length === 0) {
    host.append(
      Object.assign(document.createElement('p'), {
        className: 'dep-empty',
        textContent: 'No tasks to draw.',
      }),
    );
    return;
  }

  const layer = layerNodes(tasks, deps);
  const columns = new Map();
  for (const t of tasks) {
    const l = layer.get(t.id) ?? 0;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l).push(t);
  }
  // Stable, readable ordering inside a column: critical work at the top.
  for (const list of columns.values()) {
    list.sort(
      (a, b) =>
        Number(b.isCritical) - Number(a.isCritical) ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
  }

  const layerKeys = [...columns.keys()].sort((a, b) => a - b);
  const position = new Map();
  let maxRows = 0;
  layerKeys.forEach((l, columnIndex) => {
    const list = columns.get(l);
    maxRows = Math.max(maxRows, list.length);
    list.forEach((t, rowIndex) => {
      position.set(t.id, {
        x: PAD + columnIndex * (NODE_W + GAP_X),
        y: PAD + 20 + rowIndex * (NODE_H + GAP_Y),
      });
    });
  });

  const width = PAD * 2 + layerKeys.length * NODE_W + (layerKeys.length - 1) * GAP_X;
  const height = PAD * 2 + 20 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': `Dependency graph with ${tasks.length} tasks in ${layerKeys.length} dependency layers, all arrows pointing left to right.`,
  });

  const defs = svgEl('defs');
  for (const [id, cls] of [
    ['arrow', 'edge'],
    ['arrow-critical', 'edge is-critical'],
  ]) {
    const marker = svgEl('marker', {
      id,
      viewBox: '0 0 8 8',
      refX: 7,
      refY: 4,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    });
    const path = svgEl('path', { d: 'M0,0 L8,4 L0,8 z' });
    path.setAttribute('class', cls.replace('edge', 'edge'));
    path.setAttribute('fill', 'currentColor');
    marker.append(path);
    marker.setAttribute('class', cls);
    defs.append(marker);
  }
  svg.append(defs);

  // Layer captions make the "depth" claim legible instead of implied.
  layerKeys.forEach((l, columnIndex) => {
    const label = svgEl('text', {
      x: PAD + columnIndex * (NODE_W + GAP_X),
      y: PAD - 4,
      class: 'graph-layer-label',
    });
    label.textContent = l === 0 ? 'no prerequisites' : `depth ${l}`;
    svg.append(label);
  });

  // Edges first so nodes paint over them.
  for (const d of deps) {
    const from = position.get(d.predecessorId);
    const to = position.get(d.successorId);
    if (!from || !to) continue;
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    const edge = svgEl('path', {
      d: `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`,
      class: `edge${d.isCritical ? ' is-critical' : ''}`,
      'marker-end': d.isCritical ? 'url(#arrow-critical)' : 'url(#arrow)',
    });
    edge.append(
      Object.assign(document.createElementNS(SVG, 'title'), {
        textContent: `${d.predecessorKey} must finish before ${d.successorKey} starts`,
      }),
    );
    svg.append(edge);
  }

  for (const task of tasks) {
    const { x, y } = position.get(task.id);
    const group = svgEl('g', { class: 'graph-node', tabindex: '0', role: 'button' });
    group.append(
      Object.assign(document.createElementNS(SVG, 'title'), {
        textContent:
          `${task.key}: ${task.title}\n${task.scheduledStart} → ${task.scheduledEnd}\n` +
          (task.isCritical ? 'On the critical path' : `${task.slackDays} day(s) slack`),
      }),
    );

    const box = svgEl('rect', {
      x,
      y,
      width: NODE_W,
      height: NODE_H,
      rx: 7,
      class: `node-box${task.isCritical ? ' is-critical' : ''}${task.depState === 'BLOCKED' ? ' is-blocked' : ''}`,
    });
    group.append(box);

    const key = svgEl('text', { x: x + 11, y: y + 19, class: 'node-key' });
    key.textContent = task.key;
    group.append(key);

    const title = svgEl('text', { x: x + 11, y: y + 36, class: 'node-title' });
    title.textContent = task.title.length > 24 ? `${task.title.slice(0, 23)}…` : task.title;
    group.append(title);

    const dates = svgEl('text', { x: x + 11, y: y + 52, class: 'node-dates' });
    dates.textContent = `${task.scheduledStart.slice(5)} → ${task.scheduledEnd.slice(5)}`;
    group.append(dates);

    group.addEventListener('click', () => options.onSelect(task));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        options.onSelect(task);
      }
    });
    svg.append(group);
  }

  host.append(svg);
}
