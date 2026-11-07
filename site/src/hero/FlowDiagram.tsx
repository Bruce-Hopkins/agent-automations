import { useId, useMemo } from "react";
import { cssVars, sec } from "../hooks";
import type { Layout, Pt } from "./layout";
import { buildTimeline, TIMING, type TimedEdge } from "./timeline";

interface Props {
  layout: Layout;
  /** Start the build animation. Before this everything past the background is hidden. */
  live: boolean;
}

export function FlowDiagram({ layout, live }: Props) {
  const t = useMemo(() => buildTimeline(layout), [layout]);
  const ids = useId();
  const titleId = `${ids}-title`;
  const glowId = `${ids}-glow`;
  const leafIds = { fill: `${ids}-leaf`, mask: `${ids}-leaf-mask` };
  const { w, h } = layout.viewBox;
  const { box } = layout.hub;
  const cx = box.x + box.w / 2;

  return (
    <svg
      className={`flow${live ? " is-live" : ""}`}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-labelledby={titleId}
      style={cssVars({ "--pulse-period": sec(t.pulsePeriod) })}
    >
      <title id={titleId}>{describe(layout)}</title>
      <defs>
        <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <LeafDefs ids={leafIds} />
      </defs>

      {/* Hermes: the border draws from the top and closes at the bottom, where the trunk leaves. */}
      <g className="hub">
        <rect
          className="hub-fill"
          x={box.x} y={box.y} width={box.w} height={box.h} rx={box.r}
          style={cssVars({ "--at": sec(TIMING.hubStart + 0.25) })}
        />
        {[t.hub.left, t.hub.right].map((d, i) => (
          <path
            key={i} className="hub-stroke" d={d} pathLength={1}
            style={cssVars({ "--delay": sec(TIMING.hubStart), "--dur": sec(TIMING.hubDraw) })}
          />
        ))}
        <text
          className="hub-label" x={cx} y={box.y + box.h / 2 + 4} fontSize={layout.font.hub}
          style={cssVars({ "--at": sec(TIMING.hubStart + 0.35) })}
        >
          {layout.hub.label}
        </text>
        <text
          className="hub-sub" x={cx} y={box.y + box.h / 2 + 4 + layout.font.hubSub + 11} fontSize={layout.font.hubSub}
          style={cssVars({ "--at": sec(TIMING.hubStart + 0.5) })}
        >
          {layout.hub.sub}
        </text>
      </g>

      <g className="edges">
        {t.edges.map((e) => <path key={`g-${e.node.id}`} className="edge-glow" d={e.d} pathLength={1} style={drawVars(e)} />)}
        {t.edges.map((e) => <path key={`l-${e.node.id}`} className="edge" d={e.d} pathLength={1} style={drawVars(e)} />)}
      </g>

      <g className="pulses" filter={`url(#${glowId})`}>
        {t.edges.map((e) => (
          <path
            key={`p-${e.node.id}`} className="pulse" d={e.d} pathLength={1}
            style={cssVars({
              "--pd": e.pulse.dash, "--pg": e.pulse.gap,
              "--pf": e.pulse.from, "--pt": e.pulse.to,
              "--pdelay": sec(e.pulse.delay),
            })}
          />
        ))}
      </g>

      <g className="nodes">
        {t.edges.map((e) => <NodeMark key={e.node.id} edge={e} layout={layout} leafIds={leafIds} />)}
      </g>
    </svg>
  );
}

function NodeMark({ edge, layout, leafIds }: { edge: TimedEdge; layout: Layout; leafIds: LeafIds }) {
  const R = layout.nodeRadius;
  const [x, y] = edge.center;
  const { node } = edge;
  const label = labelPlacement(edge.center, R, node.labelSide, layout.font);
  return (
    <g className={`node${node.person ? " is-person" : ""}`} style={cssVars({ "--at": sec(edge.arrive) })}>
      <circle className="node-ripple" cx={x} cy={y} r={R} />
      <g className="node-core">
        <circle className="node-ring" cx={x} cy={y} r={R} />
        {node.person ? <Leaf x={x} y={y} height={R * 1.45} ids={leafIds} /> : <circle className="node-dot" cx={x} cy={y} r={R * 0.3} />}
      </g>
      <g className="node-text" textAnchor={label.anchor}>
        <text className="node-label" x={label.x} y={label.labelY} fontSize={layout.font.label}>{node.label}</text>
        <text className="node-sub" x={label.x} y={label.subY} fontSize={layout.font.sub}>{node.sub}</text>
      </g>
    </g>
  );
}

// The logo (site/public/leaf.svg), in its own 512-unit space: a leaf whose
// veins are a small agent graph. The node a person reads is the leaf the flow
// grows towards.
const LEAF_OUTLINE =
  "M341 46C380 72 398 130 399 200C400 270 392 330 372 380C352 430 310 462 262 464C220 466 178 446 150 410C122 374 112 320 124 280C136 240 160 222 200 204C250 182 285 150 313 106C326 86 334 66 341 46Z";
const LEAF_EDGES = [
  "M222 362C240 332 256 300 270 270C282 244 290 228 295 217",
  "M222 362C262 342 298 330 333 316",
  "M222 362C214 340 206 322 193 304",
  "M222 362C200 388 176 414 150 440",
];
const LEAF_NODES: readonly Pt[] = [[295, 217], [333, 316], [193, 304]];
/** The outline's bounding box, before its 10-unit stroke. */
const LEAF_BOX = { cx: 259.5, cy: 255.5, h: 428 };

interface LeafIds {
  fill: string;
  mask: string;
}

function LeafDefs({ ids }: { ids: LeafIds }) {
  return (
    <>
      <linearGradient id={ids.fill} gradientUnits="userSpaceOnUse" x1="112" y1="469" x2="404" y2="41">
        <stop offset="0" style={{ stopColor: "var(--brand-cyan)" }} />
        <stop offset="0.55" style={{ stopColor: "var(--brand-emerald)" }} />
        <stop offset="1" style={{ stopColor: "var(--brand-lime)" }} />
      </linearGradient>
      {/* Keeps the graph inside the leaf, so the stem ends at its edge. */}
      <mask id={ids.mask} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
        <path d={LEAF_OUTLINE} fill="#fff" stroke="#fff" strokeWidth={10} strokeLinejoin="round" />
      </mask>
    </>
  );
}

/** The logo's leaf, `height` tall and centred on (x, y). Strokes use the favicon's weights, which hold up small. */
function Leaf({ x, y, height, ids }: { x: number; y: number; height: number; ids: LeafIds }) {
  const scale = height / LEAF_BOX.h;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale}) translate(${-LEAF_BOX.cx} ${-LEAF_BOX.cy})`}>
      <path d={LEAF_OUTLINE} fill={`url(#${ids.fill})`} stroke={`url(#${ids.fill})`} strokeWidth={10} strokeLinejoin="round" />
      <g mask={`url(#${ids.mask})`} fill="#fff" stroke="#fff">
        <g strokeWidth={18} strokeLinecap="round" fill="none">
          {LEAF_EDGES.map((d) => <path key={d} d={d} />)}
        </g>
        {LEAF_NODES.map(([cx, cy]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={30} stroke="none" />)}
      </g>
    </g>
  );
}

type Anchor = "start" | "middle" | "end";

function labelPlacement(
  [x, y]: Pt,
  R: number,
  side: Layout["nodes"][number]["labelSide"],
  font: Layout["font"],
): { x: number; anchor: Anchor; labelY: number; subY: number } {
  if (side === "below") {
    const labelY = y + R + 12 + font.label * 0.8;
    return { x, anchor: "middle", labelY, subY: labelY + font.sub + 8 };
  }
  const gap = R + 16;
  return {
    x: side === "left" ? x - gap : x + gap,
    anchor: side === "left" ? "end" : "start",
    labelY: y - 3,
    subY: y + font.sub + 5,
  };
}

function drawVars(e: TimedEdge) {
  return cssVars({ "--delay": sec(e.delay), "--dur": sec(e.duration) });
}

function describe(layout: Layout) {
  const children = (parent: string) => layout.nodes.filter((n) => n.parent === parent);
  const tell = (parent: string): string =>
    children(parent)
      .map((n) => {
        const next = tell(n.id);
        return next ? `${n.label} (which hands work on to ${next})` : n.label;
      })
      .join(" and ");
  return `${layout.hub.label} starts a flow of agent nodes: ${tell("hermes")}.`;
}
