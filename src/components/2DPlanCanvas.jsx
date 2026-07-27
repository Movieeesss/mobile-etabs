import React, { useRef, useState, useCallback, useMemo, useEffect } from "react";

const MIN_SCALE = 15;
const MAX_SCALE = 220;

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function PlanCanvas2D({ model, ui, activeStory, dispatchModel, dispatchUI }) {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ scale: 60, panX: 0, panY: 0 });
  const [drawStart, setDrawStart] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toScreen = (xm, ym) => [
    containerSize.w / 2 + view.panX + xm * view.scale,
    containerSize.h / 2 + view.panY - ym * view.scale,
  ];

  const toWorld = (xpx, ypx) => [
    (xpx - containerSize.w / 2 - view.panX) / view.scale,
    -(ypx - containerSize.h / 2 - view.panY) / view.scale,
  ];

  const storyNodes = useMemo(() => model.nodes.filter((n) => n.storyId === activeStory?.id), [model.nodes, activeStory]);
  const storyElements = useMemo(() => model.elements.filter((el) => el.storyId === activeStory?.id), [model.elements, activeStory]);
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);

  const handleTap = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);

    if (ui.activeTool === "DRAW_NODE") {
      const id = uid("node");
      dispatchModel({
        type: "ADD_NODE",
        payload: { id, storyId: activeStory.id, x: wx, y: wy, z: activeStory.elevation, support: "FREE" }
      });
    }
  };

  return (
    <div ref={containerRef} className="absolute inset-0 bg-slate-950 touch-none select-none" onClick={handleTap}>
      <svg width={containerSize.w} height={containerSize.h} className="block">
        {storyNodes.map((n) => {
          const [x, y] = toScreen(n.x, n.y);
          return <circle key={n.id} cx={x} cy={y} r={5} fill="#e2e8f0" />;
        })}
        {storyElements.filter(el => el.kind === "BEAM").map((b) => {
          const n1 = nodeById.get(b.nodeIds[0]);
          const n2 = nodeById.get(b.nodeIds[1]);
          if (!n1 || !n2) return null;
          const [x1, y1] = toScreen(n1.x, n1.y);
          const [x2, y2] = toScreen(n2.x, n2.y);
          return <line key={b.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#38bdf8" strokeWidth={4} />;
        })}
      </svg>
      <div className="absolute left-3 top-3 px-2 py-1 bg-slate-900/80 text-slate-400 text-xs font-mono rounded">
        Tool: {ui.activeTool} | Tap to add nodes
      </div>
    </div>
  );
}
