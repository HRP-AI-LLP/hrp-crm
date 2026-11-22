/**
 * Diagrams as data. The AI (or a person) describes a diagram as a small JSON spec; from it come
 *  · Mermaid source (renders in the app, in GitHub / GitLab / Notion, and to SVG / PNG / JPG), and
 *  · a draw.io (diagrams.net) file with real, editable shapes laid out automatically.
 *
 * Kinds with a spec: flowchart, architecture, data flow, block, network, deployment, C4 context /
 * container, use case, mind map, org chart, swimlane (process with lanes), state, class, ER,
 * sequence and user journey. Other Mermaid kinds (gantt, timeline, pie, quadrant, git graph, sankey,
 * requirement, kanban — or any Mermaid) are kept as Mermaid source; the browser draws them and
 * places the picture in the draw.io file.
 *
 * Imported as '@synapse/shared/diagrams' (not from the package root: it brings the layout engine).
 */
import dagre from '@dagrejs/dagre';
import { z } from 'zod';

/* ───────────────────────── kinds ───────────────────────── */

export const GRAPH_TYPES = ['flowchart', 'architecture', 'data_flow', 'block', 'network', 'deployment', 'c4_context', 'c4_container', 'use_case', 'mindmap', 'org_chart', 'swimlane', 'state'] as const;
export const MERMAID_TYPES = ['gantt', 'timeline', 'pie', 'quadrant', 'gitgraph', 'sankey', 'requirement', 'kanban', 'mermaid'] as const;
export const DIAGRAM_TYPES = [...GRAPH_TYPES, 'class', 'er', 'sequence', 'user_journey', ...MERMAID_TYPES] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export const DIAGRAM_LABELS: Record<DiagramType, string> = {
  flowchart: 'Flowchart / process',
  architecture: 'Architecture',
  data_flow: 'Data flow (DFD)',
  block: 'Block diagram',
  network: 'Network',
  deployment: 'Deployment / infrastructure',
  c4_context: 'C4 — system context',
  c4_container: 'C4 — containers',
  use_case: 'Use case',
  mindmap: 'Mind map',
  org_chart: 'Org chart / hierarchy',
  swimlane: 'Swimlane (cross-functional process)',
  state: 'State machine',
  class: 'Class diagram',
  er: 'ER (entity–relationship)',
  sequence: 'Sequence',
  user_journey: 'User journey',
  gantt: 'Gantt',
  timeline: 'Timeline',
  pie: 'Pie chart',
  quadrant: 'Quadrant',
  gitgraph: 'Git branching',
  sankey: 'Sankey',
  requirement: 'Requirement diagram',
  kanban: 'Kanban',
  mermaid: 'Other (Mermaid)',
};

/* ───────────────────────── specs ───────────────────────── */

export const SHAPES = [
  'process', 'decision', 'start', 'end', 'database', 'datastore', 'queue', 'cache', 'storage', 'cloud', 'actor', 'external', 'document', 'service', 'client',
  'gateway', 'function', 'note', 'usecase', 'system', 'container', 'component', 'state', 'initial', 'final', 'io', 'server', 'firewall', 'user_group',
] as const;
export type Shape = (typeof SHAPES)[number];

const id = z.string().trim().min(1).max(80);
const label = z.string().max(300);
const shape = z.preprocess((v) => (typeof v === 'string' && (SHAPES as readonly string[]).includes(v) ? v : 'process'), z.enum(SHAPES));

export const graphSpec = z.object({
  type: z.enum(GRAPH_TYPES),
  title: z.string().max(200).optional(),
  direction: z.enum(['TB', 'LR', 'BT', 'RL']).optional(),
  groups: z.array(z.object({ id, label, parent: id.nullish(), kind: z.enum(['boundary', 'lane', 'zone', 'composite']).nullish() })).max(60).default([]),
  nodes: z.array(z.object({ id, label, shape: shape.optional(), group: id.nullish(), tech: z.string().max(120).nullish(), description: z.string().max(400).nullish() })).min(1).max(150),
  edges: z.array(z.object({ from: id, to: id, label: z.string().max(200).nullish(), style: z.enum(['solid', 'dashed', 'dotted']).nullish(), arrow: z.enum(['none', 'one', 'both']).nullish() })).max(300).default([]),
});
export const erSpec = z.object({
  type: z.literal('er'),
  title: z.string().max(200).optional(),
  entities: z
    .array(z.object({ name: id, attributes: z.array(z.object({ name: z.string().max(80), type: z.string().max(60).default('string'), key: z.enum(['PK', 'FK', 'UK']).nullish(), note: z.string().max(120).nullish() })).max(60).default([]) }))
    .min(1)
    .max(60),
  relations: z.array(z.object({ from: id, to: id, card: z.enum(['1-1', '1-n', 'n-1', 'n-n', '0-1', '1-0n']).default('1-n'), label: z.string().max(80).nullish() })).max(150).default([]),
});
export const classSpec = z.object({
  type: z.literal('class'),
  title: z.string().max(200).optional(),
  classes: z.array(z.object({ name: id, stereotype: z.string().max(40).nullish(), attributes: z.array(z.string().max(160)).max(40).default([]), methods: z.array(z.string().max(200)).max(40).default([]) })).min(1).max(60),
  relations: z
    .array(z.object({ from: id, to: id, kind: z.enum(['inheritance', 'composition', 'aggregation', 'association', 'dependency', 'realization']).default('association'), label: z.string().max(80).nullish() }))
    .max(150)
    .default([]),
});
type SeqStep = { from?: string; to?: string; label?: string; kind?: 'sync' | 'async' | 'reply'; note?: string; over?: string[]; group?: 'alt' | 'opt' | 'loop' | 'par' | 'critical'; steps?: SeqStep[]; else?: { label: string; steps: SeqStep[] }[] };
const seqStep: z.ZodType<SeqStep> = z.lazy(() =>
  z.object({
    from: id.optional(),
    to: id.optional(),
    label: z.string().max(300).optional(),
    kind: z.enum(['sync', 'async', 'reply']).optional(),
    note: z.string().max(300).optional(),
    over: z.array(id).max(10).optional(),
    group: z.enum(['alt', 'opt', 'loop', 'par', 'critical']).optional(),
    steps: z.array(seqStep).max(100).optional(),
    else: z.array(z.object({ label: z.string().max(200), steps: z.array(seqStep).max(100) })).max(10).optional(),
  }),
) as z.ZodType<SeqStep>;
export const sequenceSpec = z.object({
  type: z.literal('sequence'),
  title: z.string().max(200).optional(),
  participants: z.array(z.object({ id, label: label.optional(), kind: z.enum(['actor', 'participant', 'database', 'queue', 'boundary', 'service']).default('participant') })).min(1).max(30),
  steps: z.array(seqStep).min(1).max(200),
});
export const journeySpec = z.object({
  type: z.literal('user_journey'),
  title: z.string().max(200).optional(),
  actor: z.string().max(80).default('User'),
  stages: z
    .array(z.object({ name: z.string().max(80), steps: z.array(z.object({ task: z.string().max(160), score: z.coerce.number().int().min(1).max(5).default(3), actors: z.array(z.string().max(60)).max(6).optional(), pain: z.string().max(200).nullish(), opportunity: z.string().max(200).nullish() })).min(1).max(20) }))
    .min(1)
    .max(15),
});
export const mermaidSpec = z.object({ type: z.enum(MERMAID_TYPES), title: z.string().max(200).optional(), mermaid: z.string().min(1).max(40000) });

export type GraphSpec = z.infer<typeof graphSpec>;
export type ErSpec = z.infer<typeof erSpec>;
export type ClassSpec = z.infer<typeof classSpec>;
export type SequenceSpec = z.infer<typeof sequenceSpec>;
export type JourneySpec = z.infer<typeof journeySpec>;
export type MermaidSpec = z.infer<typeof mermaidSpec>;
export type DiagramSpec = GraphSpec | ErSpec | ClassSpec | SequenceSpec | JourneySpec | MermaidSpec;

/** Checks and normalises a spec: unknown shapes become boxes, edges to missing nodes are dropped, ids are made safe. */
export function parseSpec(raw: unknown): DiagramSpec {
  const t = (raw as { type?: string } | null)?.type;
  if (t === 'er') return erSpec.parse(raw);
  if (t === 'class') return classSpec.parse(raw);
  if (t === 'sequence') return sequenceSpec.parse(raw);
  if (t === 'user_journey') return journeySpec.parse(raw);
  if ((MERMAID_TYPES as readonly string[]).includes(String(t))) return mermaidSpec.parse(raw);
  const g = graphSpec.parse(raw);
  const nodes = new Set(g.nodes.map((n) => n.id));
  const groups = new Set(g.groups.map((x) => x.id));
  return {
    ...g,
    groups: g.groups.map((x) => ({ ...x, parent: x.parent && groups.has(x.parent) && x.parent !== x.id ? x.parent : null })),
    nodes: g.nodes.filter((n, i, a) => a.findIndex((m) => m.id === n.id) === i).map((n) => ({ ...n, group: n.group && groups.has(n.group) ? n.group : null })),
    edges: g.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
  };
}

/* ───────────────────────── Mermaid ───────────────────────── */

const safeId = (s: string) => {
  const x = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(x) ? x : `n_${x}`;
};
const q = (s: string) => `"${s.replace(/"/g, '#quot;').replace(/\n/g, '<br/>')}"`;
const MM_SHAPE: Record<Shape, string> = {
  process: 'rect', decision: 'diam', start: 'stadium', end: 'stadium', database: 'cyl', datastore: 'lin-cyl', queue: 'h-cyl', cache: 'cyl', storage: 'cyl', cloud: 'stadium',
  actor: 'stadium', external: 'rect', document: 'doc', service: 'rounded', client: 'rounded', gateway: 'hex', function: 'hex', note: 'brace', usecase: 'stadium', system: 'rect',
  container: 'rounded', component: 'rect', state: 'rounded', initial: 'sm-circ', final: 'fr-circ', io: 'lean-r', server: 'rect', firewall: 'hex', user_group: 'stadium',
};
const ICON: Partial<Record<Shape, string>> = { actor: '👤 ', user_group: '👥 ', client: '🖥 ', cloud: '☁ ', firewall: '🛡 ', server: '🖧 ' };

function nodeLabel(n: GraphSpec['nodes'][number]) {
  const base = `${ICON[n.shape ?? 'process'] ?? ''}${n.label}`;
  return n.tech ? `${base}\n[${n.tech}]` : base;
}

function graphToMermaid(s: GraphSpec): string {
  if (s.type === 'state') return stateToMermaid(s);
  if (s.type === 'mindmap') return mindmapToMermaid(s);
  const dir = s.direction ?? (s.type === 'org_chart' ? 'TB' : 'LR');
  const out = [`flowchart ${dir}`];
  const byGroup = new Map<string | null, GraphSpec['nodes']>();
  for (const n of s.nodes) byGroup.set(n.group ?? null, [...(byGroup.get(n.group ?? null) ?? []), n]);
  const node = (n: GraphSpec['nodes'][number], ind: string) => `${ind}${safeId(n.id)}@{ shape: ${MM_SHAPE[n.shape ?? 'process']}, label: ${q(nodeLabel(n))} }`;
  const emit = (gid: string | null, ind: string) => {
    for (const n of byGroup.get(gid) ?? []) out.push(node(n, ind));
    for (const g of s.groups.filter((x) => (x.parent ?? null) === gid)) {
      out.push(`${ind}subgraph ${safeId(`g_${g.id}`)}[${q(g.label)}]`);
      if (s.type === 'swimlane') out.push(`${ind}  direction LR`);
      emit(g.id, `${ind}  `);
      out.push(`${ind}end`);
    }
  };
  emit(null, '  ');
  for (const e of s.edges) {
    const both = e.arrow === 'both';
    const none = e.arrow === 'none';
    const dashed = e.style === 'dashed' || e.style === 'dotted';
    const arrow = dashed ? (none ? '-.-' : both ? '<-.->' : '-.->') : none ? '---' : both ? '<-->' : '-->';
    out.push(`  ${safeId(e.from)} ${arrow}${e.label ? `|${q(e.label)}|` : ''} ${safeId(e.to)}`);
  }
  // C4 and boundary groups: dashed outlines
  for (const g of s.groups) if (g.kind === 'boundary') out.push(`  style ${safeId(`g_${g.id}`)} stroke-dasharray: 5 5`);
  return out.join('\n');
}

function stateToMermaid(s: GraphSpec): string {
  const out = ['stateDiagram-v2'];
  if (s.direction === 'LR') out.push('  direction LR');
  const name = (nid: string) => {
    const n = s.nodes.find((x) => x.id === nid);
    return n?.shape === 'initial' || n?.shape === 'final' ? '[*]' : safeId(nid);
  };
  const byGroup = new Map<string | null, GraphSpec['nodes']>();
  for (const n of s.nodes) byGroup.set(n.group ?? null, [...(byGroup.get(n.group ?? null) ?? []), n]);
  const emit = (gid: string | null, ind: string) => {
    for (const n of byGroup.get(gid) ?? []) if (n.shape !== 'initial' && n.shape !== 'final') out.push(`${ind}state ${q(n.label)} as ${safeId(n.id)}`);
    for (const g of s.groups.filter((x) => (x.parent ?? null) === gid)) {
      out.push(`${ind}state ${q(g.label)} as ${safeId(`g_${g.id}`)} {`);
      emit(g.id, `${ind}  `);
      out.push(`${ind}}`);
    }
  };
  emit(null, '  ');
  for (const e of s.edges) out.push(`  ${name(e.from)} --> ${name(e.to)}${e.label ? ` : ${e.label.replace(/\n/g, ' ')}` : ''}`);
  return out.join('\n');
}

function mindmapToMermaid(s: GraphSpec): string {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of s.edges) {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    hasParent.add(e.to);
  }
  const root = s.nodes.find((n) => !hasParent.has(n.id)) ?? s.nodes[0]!;
  const out = ['mindmap'];
  const seen = new Set<string>();
  const walk = (nid: string, depth: number) => {
    if (seen.has(nid) || depth > 12) return;
    seen.add(nid);
    const n = s.nodes.find((x) => x.id === nid);
    if (!n) return;
    const text = n.label.replace(/[()[\]{}]/g, ' ');
    out.push(`${'  '.repeat(depth + 1)}${depth === 0 ? `root((${text}))` : text}`);
    for (const c of children.get(nid) ?? []) walk(c, depth + 1);
  };
  walk(root.id, 0);
  return out.join('\n');
}

const ER_CARD: Record<ErSpec['relations'][number]['card'], string> = { '1-1': '||--||', '1-n': '||--o{', 'n-1': '}o--||', 'n-n': '}o--o{', '0-1': '|o--||', '1-0n': '||--o{' };
function erToMermaid(s: ErSpec): string {
  const out = ['erDiagram'];
  for (const e of s.entities) {
    out.push(`  ${safeId(e.name)} {`);
    for (const a of e.attributes) out.push(`    ${a.type.replace(/[^A-Za-z0-9_()[\],]/g, '_') || 'string'} ${a.name.replace(/[^A-Za-z0-9_]/g, '_')}${a.key ? ` ${a.key}` : ''}${a.note ? ` ${q(a.note)}` : ''}`);
    out.push('  }');
  }
  for (const r of s.relations) out.push(`  ${safeId(r.from)} ${ER_CARD[r.card]} ${safeId(r.to)} : ${q(r.label ?? 'has')}`);
  return out.join('\n');
}

const CLASS_REL: Record<ClassSpec['relations'][number]['kind'], string> = { inheritance: '<|--', composition: '*--', aggregation: 'o--', association: '-->', dependency: '..>', realization: '<|..' };
function classToMermaid(s: ClassSpec): string {
  const out = ['classDiagram'];
  for (const c of s.classes) {
    out.push(`  class ${safeId(c.name)} {`);
    if (c.stereotype) out.push(`    <<${c.stereotype}>>`);
    for (const a of c.attributes) out.push(`    ${a}`);
    for (const m of c.methods) out.push(`    ${m.includes('(') ? m : `${m}()`}`);
    out.push('  }');
  }
  // inheritance / realization read "parent <|-- child": the spec says child → parent
  for (const r of s.relations) {
    const flip = r.kind === 'inheritance' || r.kind === 'realization' || r.kind === 'composition' || r.kind === 'aggregation';
    const [a, b] = flip ? [r.to, r.from] : [r.from, r.to];
    out.push(`  ${safeId(a)} ${CLASS_REL[r.kind]} ${safeId(b)}${r.label ? ` : ${r.label.replace(/\n/g, ' ')}` : ''}`);
  }
  return out.join('\n');
}

function sequenceToMermaid(s: SequenceSpec): string {
  const out = ['sequenceDiagram', '  autonumber'];
  for (const p of s.participants) out.push(`  ${p.kind === 'actor' ? 'actor' : 'participant'} ${safeId(p.id)} as ${(p.label ?? p.id).replace(/[\n;]/g, ' ')}`);
  const emit = (steps: SeqStep[], ind: string) => {
    for (const st of steps) {
      if (st.group) {
        const kw = st.group;
        out.push(`${ind}${kw} ${st.label ?? ''}`);
        emit(st.steps ?? [], `${ind}  `);
        for (const e of st.else ?? []) {
          out.push(`${ind}${kw === 'par' ? 'and' : 'else'} ${e.label}`);
          emit(e.steps, `${ind}  `);
        }
        out.push(`${ind}end`);
      } else if (st.note) {
        const over = (st.over ?? []).map(safeId);
        out.push(`${ind}Note ${over.length > 1 ? `over ${over.slice(0, 2).join(',')}` : over.length ? `over ${over[0]}` : `over ${safeId(s.participants[0]!.id)}`}: ${st.note.replace(/\n/g, ' ')}`);
      } else if (st.from && st.to) {
        const arrow = st.kind === 'reply' ? '-->>' : st.kind === 'async' ? '-)' : '->>';
        out.push(`${ind}${safeId(st.from)}${arrow}${safeId(st.to)}: ${(st.label ?? '').replace(/\n/g, ' ')}`);
      }
    }
  };
  emit(s.steps, '  ');
  return out.join('\n');
}

function journeyToMermaid(s: JourneySpec): string {
  const out = ['journey', `  title ${(s.title ?? `${s.actor}'s journey`).replace(/\n/g, ' ')}`];
  for (const st of s.stages) {
    out.push(`  section ${st.name.replace(/[:\n]/g, ' ')}`);
    for (const t of st.steps) out.push(`    ${t.task.replace(/[:\n]/g, ' ')}: ${t.score}: ${(t.actors?.length ? t.actors : [s.actor]).map((a) => a.replace(/[,:]/g, ' ')).join(', ')}`);
  }
  return out.join('\n');
}

/** Mermaid source for any spec. */
export function toMermaid(spec: DiagramSpec): string {
  switch (spec.type) {
    case 'er':
      return erToMermaid(spec);
    case 'class':
      return classToMermaid(spec);
    case 'sequence':
      return sequenceToMermaid(spec);
    case 'user_journey':
      return journeyToMermaid(spec);
    default:
      if ('mermaid' in spec) return spec.mermaid;
      return graphToMermaid(spec as GraphSpec);
  }
}

/* ───────────────────────── draw.io ───────────────────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;');
const PALETTE = {
  blue: 'fillColor=#dae8fc;strokeColor=#6c8ebf;',
  green: 'fillColor=#d5e8d4;strokeColor=#82b366;',
  yellow: 'fillColor=#fff2cc;strokeColor=#d6b656;',
  orange: 'fillColor=#ffe6cc;strokeColor=#d79b00;',
  red: 'fillColor=#f8cecc;strokeColor=#b85450;',
  purple: 'fillColor=#e1d5e7;strokeColor=#9673a6;',
  grey: 'fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;',
};
const DRAWIO_SHAPE: Record<Shape, { style: string; w: number; h: number }> = {
  process: { style: `rounded=1;whiteSpace=wrap;html=1;${PALETTE.blue}`, w: 150, h: 60 },
  decision: { style: `rhombus;whiteSpace=wrap;html=1;${PALETTE.yellow}`, w: 150, h: 90 },
  start: { style: `rounded=1;arcSize=50;whiteSpace=wrap;html=1;${PALETTE.green}`, w: 130, h: 50 },
  end: { style: `rounded=1;arcSize=50;whiteSpace=wrap;html=1;${PALETTE.red}`, w: 130, h: 50 },
  database: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;${PALETTE.green}`, w: 120, h: 80 },
  datastore: { style: `shape=partialRectangle;whiteSpace=wrap;html=1;left=0;right=0;${PALETTE.green}`, w: 150, h: 50 },
  queue: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;direction=south;${PALETTE.orange}`, w: 150, h: 60 },
  cache: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;${PALETTE.red}`, w: 110, h: 70 },
  storage: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;${PALETTE.yellow}`, w: 120, h: 80 },
  cloud: { style: `ellipse;shape=cloud;whiteSpace=wrap;html=1;${PALETTE.grey}`, w: 160, h: 100 },
  actor: { style: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;', w: 40, h: 70 },
  user_group: { style: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;fillColor=#dae8fc;', w: 40, h: 70 },
  external: { style: `rounded=0;whiteSpace=wrap;html=1;strokeWidth=2;${PALETTE.grey}`, w: 150, h: 60 },
  document: { style: `shape=document;whiteSpace=wrap;html=1;boundedLbl=1;${PALETTE.yellow}`, w: 140, h: 70 },
  service: { style: `rounded=1;whiteSpace=wrap;html=1;${PALETTE.blue}`, w: 160, h: 60 },
  client: { style: `rounded=1;whiteSpace=wrap;html=1;${PALETTE.purple}`, w: 150, h: 60 },
  gateway: { style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.15;${PALETTE.orange}`, w: 160, h: 60 },
  function: { style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.15;${PALETTE.yellow}`, w: 150, h: 60 },
  note: { style: `shape=note;whiteSpace=wrap;html=1;size=14;${PALETTE.yellow}`, w: 160, h: 70 },
  usecase: { style: `ellipse;whiteSpace=wrap;html=1;${PALETTE.blue}`, w: 170, h: 70 },
  system: { style: `rounded=0;whiteSpace=wrap;html=1;fillColor=#1168bd;fontColor=#ffffff;strokeColor=#0b4884;`, w: 190, h: 90 },
  container: { style: `rounded=1;whiteSpace=wrap;html=1;fillColor=#438dd5;fontColor=#ffffff;strokeColor=#3c7fc0;`, w: 190, h: 90 },
  component: { style: `shape=component;align=left;spacingLeft=36;whiteSpace=wrap;html=1;${PALETTE.blue}`, w: 170, h: 60 },
  state: { style: `rounded=1;arcSize=40;whiteSpace=wrap;html=1;${PALETTE.blue}`, w: 140, h: 50 },
  initial: { style: 'ellipse;html=1;fillColor=#000000;strokeColor=#000000;', w: 26, h: 26 },
  final: { style: 'ellipse;html=1;shape=doubleEllipse;fillColor=#000000;strokeColor=#000000;', w: 30, h: 30 },
  io: { style: `shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;${PALETTE.purple}`, w: 160, h: 60 },
  server: { style: `rounded=0;whiteSpace=wrap;html=1;${PALETTE.grey}`, w: 140, h: 70 },
  firewall: { style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.2;${PALETTE.red}`, w: 140, h: 60 },
};

type Cell = string;
function wrapFile(title: string, cells: Cell[], w = 1600, h = 1200) {
  return `<mxfile host="SanchalanOS" type="device"><diagram id="d1" name="${esc(title.slice(0, 60) || 'Diagram')}"><mxGraphModel dx="${w}" dy="${h}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.max(1169, w)}" pageHeight="${Math.max(827, h)}" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}
const vertex = (cid: string, value: string, style: string, x: number, y: number, w: number, h: number, parent = '1') =>
  `<mxCell id="${esc(cid)}" value="${esc(value)}" style="${style}" vertex="1" parent="${esc(parent)}"><mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/></mxCell>`;
const edge = (cid: string, value: string, style: string, source: string, target: string, parent = '1') =>
  `<mxCell id="${esc(cid)}" value="${esc(value)}" style="${style}" edge="1" parent="${esc(parent)}" source="${esc(source)}" target="${esc(target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const freeEdge = (cid: string, value: string, style: string, x1: number, y1: number, x2: number, y2: number, points: [number, number][] = []) =>
  `<mxCell id="${esc(cid)}" value="${esc(value)}" style="${style}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${Math.round(x1)}" y="${Math.round(y1)}" as="sourcePoint"/><mxPoint x="${Math.round(x2)}" y="${Math.round(y2)}" as="targetPoint"/>${points.length ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('')}</Array>` : ''}</mxGeometry></mxCell>`;

/** Lays out boxes (and nested groups) with dagre; positions are absolute. */
function layout(nodes: { id: string; w: number; h: number; parent?: string | null }[], groups: { id: string; parent?: string | null }[], edges: { from: string; to: string }[], dir: string, sep = { node: 50, rank: 70 }) {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: dir, nodesep: sep.node, ranksep: sep.rank, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const gr of groups) g.setNode(`group:${gr.id}`, { label: gr.id, paddingTop: 30, paddingBottom: 20, paddingLeft: 20, paddingRight: 20 });
  for (const gr of groups) if (gr.parent) g.setParent(`group:${gr.id}`, `group:${gr.parent}`);
  for (const n of nodes) {
    g.setNode(n.id, { width: n.w, height: n.h });
    if (n.parent) g.setParent(n.id, `group:${n.parent}`);
  }
  edges.forEach((e, i) => g.setEdge(e.from, e.to, { minlen: 1 }, `e${i}`));
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const k of g.nodes()) {
    const n = g.node(k) as { x: number; y: number; width: number; height: number } | undefined;
    if (n && Number.isFinite(n.x)) pos.set(k, { x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height });
  }
  return pos;
}

function graphToDrawio(s: GraphSpec): string {
  const dir = s.direction ?? (s.type === 'org_chart' || s.type === 'state' ? 'TB' : 'LR');
  const size = (n: GraphSpec['nodes'][number]) => {
    const d = DRAWIO_SHAPE[n.shape ?? (s.type === 'state' ? 'state' : s.type === 'use_case' ? 'usecase' : 'process')];
    const lines = Math.ceil(nodeLabel(n).length / 22);
    return { w: d.w, h: Math.max(d.h, n.shape === 'actor' || n.shape === 'user_group' ? d.h : 26 + lines * 16) };
  };
  const nodes = s.nodes.map((n) => ({ id: n.id, ...size(n), parent: n.group ?? null }));
  const pos = layout(nodes, s.groups, s.edges, dir, s.type === 'mindmap' ? { node: 20, rank: 60 } : { node: 50, rank: 80 });
  const cells: Cell[] = [];
  // groups first (behind), outermost first; children keep absolute positions (parent = layer 1)
  const depth = (gid: string): number => {
    const g = s.groups.find((x) => x.id === gid);
    return g?.parent ? 1 + depth(g.parent) : 0;
  };
  for (const g of [...s.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
    const p = pos.get(`group:${g.id}`);
    if (!p) continue;
    const style =
      g.kind === 'lane' || s.type === 'swimlane'
        ? 'swimlane;horizontal=0;whiteSpace=wrap;html=1;startSize=30;fillColor=#f5f5f5;strokeColor=#666666;'
        : g.kind === 'boundary' || s.type.startsWith('c4')
          ? 'rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#666666;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;'
          : 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f9f9f9;strokeColor=#999999;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;arcSize=4;';
    cells.push(vertex(`group:${g.id}`, g.label, style, p.x, p.y - 10, p.w, p.h + 10));
  }
  for (const n of s.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const def = DRAWIO_SHAPE[n.shape ?? (s.type === 'state' ? 'state' : s.type === 'use_case' ? 'usecase' : 'process')];
    const text = n.tech ? `<b>${esc(n.label)}</b><br/><font style="font-size:10px">[${esc(n.tech)}]</font>` : n.label;
    const style = n.tech ? def.style : def.style;
    cells.push(vertex(n.id, text, style, p.x, p.y, p.w, p.h));
  }
  s.edges.forEach((e, i) => {
    const dashed = e.style === 'dashed' || e.style === 'dotted' ? 'dashed=1;' : '';
    const arrows = e.arrow === 'none' ? 'endArrow=none;' : e.arrow === 'both' ? 'startArrow=block;startFill=1;endArrow=block;endFill=1;' : 'endArrow=block;endFill=1;';
    const route = s.type === 'mindmap' || s.type === 'org_chart' ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;' : 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;';
    cells.push(edge(`e${i}`, e.label ?? '', `${route}html=1;${dashed}${arrows}fontSize=11;labelBackgroundColor=#ffffff;`, e.from, e.to));
  });
  return wrapFile(s.title ?? s.type, cells);
}

function erToDrawio(s: ErSpec): string {
  const ROW = 24;
  const boxes = s.entities.map((e) => ({ id: e.name, w: 220, h: 30 + Math.max(1, e.attributes.length) * ROW }));
  const pos = layout(boxes, [], s.relations, 'LR', { node: 60, rank: 120 });
  const cells: Cell[] = [];
  for (const e of s.entities) {
    const p = pos.get(e.name)!;
    cells.push(vertex(`t:${e.name}`, e.name, `swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;html=1;${PALETTE.blue}`, p.x, p.y, p.w, p.h));
    e.attributes.forEach((a, i) => {
      const keyStyle = a.key === 'PK' ? 'fontStyle=5;' : a.key === 'FK' ? 'fontStyle=2;' : '';
      cells.push(vertex(`t:${e.name}:${i}`, `${a.key ? `${a.key} ` : ''}${a.name}: ${a.type}`, `text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=6;spacingRight=4;overflow=hidden;rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;html=1;${keyStyle}`, 0, 30 + i * ROW, p.w, ROW, `t:${e.name}`));
    });
  }
  const ends: Record<ErSpec['relations'][number]['card'], [string, string]> = { '1-1': ['ERmandOne', 'ERmandOne'], '1-n': ['ERmandOne', 'ERmany'], 'n-1': ['ERmany', 'ERmandOne'], 'n-n': ['ERmany', 'ERmany'], '0-1': ['ERzeroToOne', 'ERmandOne'], '1-0n': ['ERmandOne', 'ERzeroToMany'] };
  s.relations.forEach((r, i) => {
    if (!pos.has(r.from) || !pos.has(r.to)) return;
    const [a, b] = ends[r.card];
    cells.push(edge(`r${i}`, r.label ?? '', `edgeStyle=entityRelationEdgeStyle;fontSize=11;html=1;startArrow=${a};endArrow=${b};startFill=0;endFill=0;labelBackgroundColor=#ffffff;`, `t:${r.from}`, `t:${r.to}`));
  });
  return wrapFile(s.title ?? 'ER diagram', cells);
}

function classToDrawio(s: ClassSpec): string {
  const ROW = 22;
  const boxes = s.classes.map((c) => ({ id: c.name, w: 240, h: 30 + (c.stereotype ? ROW : 0) + Math.max(1, c.attributes.length) * ROW + 8 + Math.max(1, c.methods.length) * ROW }));
  const pos = layout(boxes, [], s.relations.map((r) => ({ from: r.to, to: r.from })), 'TB', { node: 60, rank: 90 });
  const cells: Cell[] = [];
  for (const c of s.classes) {
    const p = pos.get(c.name)!;
    const title = c.stereotype ? `«${c.stereotype}»<br/><b>${esc(c.name)}</b>` : c.name;
    cells.push(vertex(`c:${c.name}`, title, `swimlane;fontStyle=1;align=center;verticalAlign=top;childLayout=stackLayout;horizontal=1;startSize=${c.stereotype ? 44 : 30};horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;html=1;${PALETTE.yellow}`, p.x, p.y, p.w, p.h));
    let y = c.stereotype ? 44 : 30;
    const row = (txt: string, i: string) => {
      cells.push(vertex(`c:${c.name}:${i}`, txt, 'text;strokeColor=none;fillColor=none;align=left;verticalAlign=top;spacingLeft=4;spacingRight=4;overflow=hidden;rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;html=1;', 0, y, p.w, ROW, `c:${c.name}`));
      y += ROW;
    };
    (c.attributes.length ? c.attributes : ['']).forEach((a, i) => row(a, `a${i}`));
    cells.push(vertex(`c:${c.name}:line`, '', 'line;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;spacingTop=-1;spacingLeft=3;spacingRight=3;rotatable=0;labelPosition=right;points=[];portConstraint=eastwest;', 0, y, p.w, 8, `c:${c.name}`));
    y += 8;
    (c.methods.length ? c.methods : ['']).forEach((m, i) => row(m && !m.includes('(') ? `${m}()` : m, `m${i}`));
  }
  const style: Record<ClassSpec['relations'][number]['kind'], string> = {
    inheritance: 'endArrow=block;endFill=0;endSize=12;',
    realization: 'endArrow=block;endFill=0;endSize=12;dashed=1;',
    composition: 'endArrow=diamondThin;endFill=1;endSize=14;',
    aggregation: 'endArrow=diamondThin;endFill=0;endSize=14;',
    association: 'endArrow=open;endFill=0;',
    dependency: 'endArrow=open;endFill=0;dashed=1;',
  };
  s.relations.forEach((r, i) => {
    if (!pos.has(r.from) || !pos.has(r.to)) return;
    // composition / aggregation: the diamond sits at the whole (the spec's "to")
    cells.push(edge(`r${i}`, r.label ?? '', `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${style[r.kind]}`, `c:${r.from}`, `c:${r.to}`));
  });
  return wrapFile(s.title ?? 'Class diagram', cells);
}

function sequenceToDrawio(s: SequenceSpec): string {
  const GAP = 200;
  const TOP = 40;
  const HEAD = 50;
  const ROW = 46;
  const x = new Map(s.participants.map((p, i) => [p.id, 40 + i * GAP + 60]));
  const cells: Cell[] = [];
  let y = TOP + HEAD + 30;
  let n = 0;
  const frames: Cell[] = [];
  const walk = (steps: SeqStep[], depth: number) => {
    for (const st of steps) {
      if (st.group) {
        const top = y;
        y += 30;
        const involved = new Set<string>();
        const collect = (ss: SeqStep[]) => ss.forEach((t) => (t.from && involved.add(t.from), t.to && involved.add(t.to), t.steps && collect(t.steps), t.else?.forEach((e) => collect(e.steps))));
        collect([st]);
        walk(st.steps ?? [], depth + 1);
        const dividers: number[] = [];
        for (const e of st.else ?? []) {
          dividers.push(y);
          y += 26;
          walk(e.steps, depth + 1);
        }
        const xs = [...involved].map((p) => x.get(p)).filter((v): v is number => v !== undefined);
        const x1 = (xs.length ? Math.min(...xs) : 100) - 80 - depth * 8;
        const x2 = (xs.length ? Math.max(...xs) : 300) + 80 + depth * 8;
        frames.push(vertex(`f${n++}`, `${st.group}${st.label ? ` [${st.label}]` : ''}`, 'shape=umlFrame;whiteSpace=wrap;html=1;pointerEvents=0;width=110;height=24;fillColor=none;align=left;spacingLeft=6;fontSize=11;', x1, top, x2 - x1, y - top + 6));
        st.else?.forEach((e, i) => {
          frames.push(freeEdge(`fd${n++}`, '', 'endArrow=none;dashed=1;html=1;strokeColor=#666666;', x1, dividers[i]!, x2, dividers[i]!));
          frames.push(vertex(`fl${n++}`, `[${e.label}]`, 'text;html=1;align=left;fontSize=11;fontStyle=2;', x1 + 8, dividers[i]! + 2, 200, 20));
        });
        y += 14;
      } else if (st.note) {
        const xs = (st.over ?? []).map((p) => x.get(p)).filter((v): v is number => v !== undefined);
        const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : (x.get(s.participants[0]!.id) ?? 100);
        const w = Math.max(160, xs.length > 1 ? Math.max(...xs) - Math.min(...xs) + 120 : 160);
        cells.push(vertex(`n${n++}`, st.note, `shape=note;whiteSpace=wrap;html=1;size=10;fontSize=11;${PALETTE.yellow}`, cx - w / 2, y - 8, w, 36));
        y += ROW;
      } else if (st.from && st.to && x.has(st.from) && x.has(st.to)) {
        const x1 = x.get(st.from)!;
        const x2 = x.get(st.to)!;
        const style = st.kind === 'reply' ? 'endArrow=open;dashed=1;endFill=0;' : st.kind === 'async' ? 'endArrow=open;endFill=0;' : 'endArrow=block;endFill=1;';
        if (st.from === st.to) cells.push(freeEdge(`m${n++}`, st.label ?? '', `html=1;align=left;spacingLeft=4;fontSize=11;${style}`, x1, y, x1, y + 18, [[x1 + 50, y], [x1 + 50, y + 18]]));
        else cells.push(freeEdge(`m${n++}`, st.label ?? '', `html=1;verticalAlign=bottom;fontSize=11;labelBackgroundColor=none;${style}`, x1, y, x2, y));
        y += st.from === st.to ? ROW + 10 : ROW;
      }
    }
  };
  walk(s.steps, 0);
  const height = y + 30 - TOP;
  const lifelines = s.participants.map((p) =>
    p.kind === 'actor'
      ? vertex(`p:${p.id}`, p.label ?? p.id, 'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;dropTarget=0;collapsible=0;recursiveResize=0;outlineConnect=0;participant=umlActor;verticalAlign=top;labelPosition=center;verticalLabelPosition=bottom;align=center;size=50;', x.get(p.id)! - 20, TOP, 40, height)
      : vertex(
          `p:${p.id}`,
          p.label ?? p.id,
          `shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;dropTarget=0;collapsible=0;recursiveResize=0;outlineConnect=0;size=${HEAD};${p.kind === 'database' ? PALETTE.green : p.kind === 'queue' ? PALETTE.orange : PALETTE.blue}`,
          x.get(p.id)! - 70,
          TOP,
          140,
          height,
        ),
  );
  return wrapFile(s.title ?? 'Sequence diagram', [...lifelines, ...frames, ...cells], 40 + s.participants.length * GAP + 200, height + 120);
}

function journeyToDrawio(s: JourneySpec): string {
  const W = 220;
  const cells: Cell[] = [];
  const color = (score: number) => [PALETTE.red, PALETTE.orange, PALETTE.yellow, PALETTE.green, PALETTE.green][Math.max(0, Math.min(4, score - 1))]!;
  const tallest = Math.max(...s.stages.map((st) => st.steps.length));
  const laneH = 60 + tallest * 92;
  cells.push(vertex('title', `<b>${esc(s.title ?? `${s.actor}'s journey`)}</b>`, 'text;html=1;fontSize=16;align=left;', 20, 10, 600, 30));
  s.stages.forEach((st, i) => {
    const x = 20 + i * (W + 16);
    cells.push(vertex(`s${i}`, st.name, `swimlane;whiteSpace=wrap;html=1;startSize=34;fontStyle=1;${PALETTE.grey}`, x, 50, W, laneH));
    st.steps.forEach((t, j) => {
      const extra = [t.pain ? `😟 ${esc(t.pain)}` : '', t.opportunity ? `💡 ${esc(t.opportunity)}` : ''].filter(Boolean).join('<br/>');
      cells.push(vertex(`s${i}t${j}`, `<b>${esc(t.task)}</b><br/><font style="font-size:10px">${'★'.repeat(t.score)}${'☆'.repeat(5 - t.score)}${t.actors?.length ? ` · ${esc(t.actors.join(', '))}` : ''}</font>${extra ? `<br/><font style="font-size:10px">${extra}</font>` : ''}`, `rounded=1;whiteSpace=wrap;html=1;arcSize=10;${color(t.score)}`, 12, 46 + j * 92, W - 24, 80, `s${i}`));
    });
  });
  return wrapFile(s.title ?? 'User journey', cells, 40 + s.stages.length * (W + 16), laneH + 80);
}

/** draw.io (diagrams.net) XML for a spec; null for Mermaid-only kinds (the browser adds their picture). */
export function toDrawio(spec: DiagramSpec): string | null {
  switch (spec.type) {
    case 'er':
      return erToDrawio(spec);
    case 'class':
      return classToDrawio(spec);
    case 'sequence':
      return sequenceToDrawio(spec);
    case 'user_journey':
      return journeyToDrawio(spec);
    default:
      if ('mermaid' in spec) return null;
      return graphToDrawio(spec as GraphSpec);
  }
}

/** A draw.io file holding one picture (SVG or PNG data URL), for kinds without editable shapes. */
export function drawioWithImage(title: string, dataUrl: string, w: number, h: number) {
  // draw.io styles separate keys with ";": the data URL goes in without its ";base64" marker
  const img = dataUrl.replace(/^data:([^;,]+);base64,/, 'data:$1,');
  return wrapFile(title, [vertex('img', '', `shape=image;html=1;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=1;aspect=fixed;image=${img};`, 20, 20, w, h)], w + 40, h + 40);
}

/* ───────────────────────── what the AI is told ───────────────────────── */

/** The JSON format of each kind, for the AI prompt. */
export function specGuide(type: DiagramType): string {
  const shapes = SHAPES.join(', ');
  if (type === 'er')
    return `{"type":"er","title":"…","entities":[{"name":"Customer","attributes":[{"name":"id","type":"uuid","key":"PK"},{"name":"email","type":"string","key":"UK"}]}],"relations":[{"from":"Customer","to":"Order","card":"1-n","label":"places"}]}  (card: 1-1, 1-n, n-1, n-n, 0-1, 1-0n; key: PK, FK, UK)`;
  if (type === 'class')
    return `{"type":"class","title":"…","classes":[{"name":"Order","stereotype":"entity","attributes":["+id: UUID","-total: Money"],"methods":["+confirm(): void"]}],"relations":[{"from":"Order","to":"OrderLine","kind":"composition","label":"1..*"}]}  (kind: inheritance (from child to parent), composition / aggregation (from part to whole), association, dependency, realization (from class to interface))`;
  if (type === 'sequence')
    return `{"type":"sequence","title":"…","participants":[{"id":"user","label":"User","kind":"actor"},{"id":"api","label":"API","kind":"service"},{"id":"db","label":"Database","kind":"database"}],"steps":[{"from":"user","to":"api","label":"POST /login","kind":"sync"},{"from":"api","to":"db","label":"find user"},{"from":"db","to":"api","label":"row","kind":"reply"},{"group":"alt","label":"password ok","steps":[{"from":"api","to":"user","label":"200 + token","kind":"reply"}],"else":[{"label":"wrong password","steps":[{"from":"api","to":"user","label":"401","kind":"reply"}]}]},{"note":"token valid 15 min","over":["user","api"]}]}  (kind: sync, async, reply; groups: alt, opt, loop, par, critical)`;
  if (type === 'user_journey')
    return `{"type":"user_journey","title":"…","actor":"Fleet manager","stages":[{"name":"Discover","steps":[{"task":"Finds the app","score":4,"pain":"…","opportunity":"…"}]}]}  (score 1 = bad … 5 = great)`;
  if ((MERMAID_TYPES as readonly string[]).includes(type))
    return `{"type":"${type}","title":"…","mermaid":"<valid Mermaid ${type === 'mermaid' ? 'diagram' : type} source, Mermaid v11 syntax>"}`;
  const hint: Partial<Record<DiagramType, string>> = {
    architecture: 'Use groups (kind "boundary" or "zone") for tiers / networks / cloud accounts; shapes client, gateway, service, function, database, queue, cache, storage, external, cloud; put the technology in "tech".',
    data_flow: 'DFD: external entities (shape "external"), processes ("process"), data stores ("datastore"); every edge carries the data that flows as its label.',
    block: 'Blocks (shape "process" / "component") grouped by subsystem; edges are signals / interfaces.',
    network: 'Shapes server, firewall, cloud, client, database; groups (kind "zone") for VPC / subnet / DMZ; edge labels for protocols and ports.',
    deployment: 'Groups for environments, regions, clusters, nodes (nested with "parent"); shapes server, container, database, queue, storage, gateway; "tech" for the runtime.',
    c4_context: 'C4 level 1: the system ("system"), people ("actor"), external systems ("external"); edge labels say what is used for what and how.',
    c4_container: 'C4 level 2: a group (kind "boundary") for the system with containers ("container", "database", "queue") inside, people and external systems outside; "tech" on each container.',
    use_case: 'Actors ("actor") outside; use cases ("usecase") inside a group (kind "boundary") named after the system; edges actor → use case; "include"/"extend" as dashed labelled edges between use cases.',
    mindmap: 'A tree: one root; edges from parent to child.',
    org_chart: 'A tree: edges from manager to report; label "Name\\nRole".',
    swimlane: 'One group (kind "lane") per role or system; every node has its lane as "group"; shapes start, process, decision, end, document; edges in process order.',
    state: 'Shapes "initial" and "final" for start / end; states "state"; groups (kind "composite") for composite states; edge labels are events [guard] / action.',
    flowchart: 'Shapes start, process, decision, io, document, end; decision edges labelled yes / no.',
  };
  return `{"type":"${type}","title":"…","direction":"LR or TB","groups":[{"id":"g1","label":"…","parent":null,"kind":"boundary|lane|zone|composite"}],"nodes":[{"id":"n1","label":"…","shape":"<one of: ${shapes}>","group":"g1","tech":"optional technology"}],"edges":[{"from":"n1","to":"n2","label":"optional","style":"solid|dashed|dotted","arrow":"one|both|none"}]}. ${hint[type] ?? ''}`;
}
