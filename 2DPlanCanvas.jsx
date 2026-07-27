import React, { useRef, useState, useCallback, useMemo, useEffect } from "react";

/**
 * 2D plan/story canvas.
 * - Renders the active story's grid, nodes, beams, and slabs as SVG (crisp at any DPR,
 *   trivial to hit-test, and cheap enough for typical building models on mobile).
 * - Columns are shown as filled squares at the node (a column is a vertical member;
 *   in plan it reads as a "thicker" node marker) with a small connector glyph.
 * - Pan: single-finger / mouse drag when tool === SELECT and the drag doesn't start on
 *   a hit-testable entity. Zoom: wheel (desktop) or two-finger pinch (touch).
 * - Snap-to-grid: pointer position is snapped to the nearest grid-line intersection
 *   (and, if closer, to the nearest existing node) before being used by any draw tool.
 */

const MIN_SCALE = 15; // px per meter
const MAX_SCALE = 220;

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Builds the world (meters) -> screen (px) transform from pan/zoom state. */
function useTransform(view, containerSize) {
  return useMemo(() => {
    const { scale, panX, panY } = view;
    const toScreen = (xm, ym) => [
      containerSize.w / 2 + panX + xm * scale,
      containerSize.h / 2 + panY - ym * scale, // flip Y: screen-down vs. plan-up
    ];
    const toWorld = (xpx, ypx) => [
      (xpx - containerSize.w / 2 - panX) / scale,
      -(ypx - containerSize.h / 2 - panY) / scale,
    ];
    return { toScreen, toWorld };
  }, [view, containerSize]);
}

function gridIntersections(grid) {
  const pts = [];
  for (const gx of grid.xAxes) {
    for (const gy of grid.yAxes) {
      pts.push({ x: gx.position, y: gy.position, xAxisId: gx.id, yAxisId: gy.id });
    }
  }
  return pts;
}

function nearestSnapPoint(worldX, worldY, grid, nodes, activeStoryId, scale) {
  const snapToleranceWorld = 14 / scale; // px tolerance converted to meters
  let best = null;
  let bestDist = Infinity;

  // Prefer snapping to an existing node on this story first (so beams connect exactly).
  for (const n of nodes) {
    if (n.storyId !== activeStoryId) continue;
    const d = Math.hypot(n.x - worldX, n.y - worldY);
    if (d < bestDist) {
      bestDist = d;
      best = { x: n.x, y: n.y, existingNodeId: n.id, gridRef: n.gridRef };
    }
  }

  for (const gi of gridIntersections(grid)) {
    const d = Math.hypot(gi.x - worldX, gi.y - worldY);
    if (d < bestDist) {
      bestDist = d;
      best = { x: gi.x, y: gi.y, existingNodeId: null, gridRef: { xAxisId: gi.xAxisId, yAxisId: gi.yAxisId } };
    }
  }

  if (best && bestDist <= snapToleranceWorld) return best;
  return { x: worldX, y: worldY, existingNodeId: null, gridRef: null };
}

export default function PlanCanvas2D({ model, ui, activeStory, dispatchModel, dispatchUI }) {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ scale: 60, panX: 0, panY: 0 });
  const [drawStart, setDrawStart] = useState(null); // node id for beam/column-in-progress
  const [slabDraft, setSlabDraft] = useState([]); // array of node ids while placing a slab
  const [cursorWorld, setCursorWorld] = useState(null);

  const pointers = useRef(new Map()); // active pointer id -> {x,y}, for pinch-zoom
  const dragState = useRef(null); // { mode: "pan", startX, startY, startPanX, startPanY }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { toScreen, toWorld } = useTransform(view, containerSize);

  const storyNodes = useMemo(
    () => model.nodes.filter((n) => n.storyId === activeStory?.id),
    [model.nodes, activeStory]
  );
  const storyElements = useMemo(
    () => model.elements.filter((el) => el.storyId === activeStory?.id),
    [model.elements, activeStory]
  );

  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);

  const findNodeBelow = useCallback(
    (x, y) => {
      const idx = model.stories.findIndex((s) => s.id === activeStory?.id);
      if (idx <= 0) return null;
      const belowStoryId = model.stories[idx - 1].id;
      return model.nodes.find((n) => n.storyId === belowStoryId && n.x === x && n.y === y) || null;
    },
    [model.stories, model.nodes, activeStory]
  );

  const ensureNode = useCallback(
    (snap) => {
      if (snap.existingNodeId) return snap.existingNodeId;
      const id = uid("node");
      dispatchModel({
        type: "ADD_NODE",
        payload: {
          id,
          storyId: activeStory.id,
          gridRef: snap.gridRef,
          x: snap.x,
          y: snap.y,
          z: activeStory.elevation,
          support: "FREE",
        },
      });
      return id;
    },
    [dispatchModel, activeStory]
  );

  const handleTap = useCallback(
    (worldX, worldY) => {
      const snap = ui.snapToGrid
        ? nearestSnapPoint(worldX, worldY, model.grid, model.nodes, activeStory.id, view.scale)
        : { x: worldX, y: worldY, existingNodeId: null, gridRef: null };

      switch (ui.activeTool) {
        case "DRAW_NODE": {
          ensureNode(snap);
          break;
        }
        case "DRAW_BEAM": {
          const nodeId = ensureNode(snap);
          if (!drawStart) {
            setDrawStart(nodeId);
          } else if (drawStart !== nodeId) {
            dispatchModel({
              type: "ADD_ELEMENT",
              payload: {
                id: uid("beam"),
                kind: "BEAM",
                storyId: activeStory.id,
                nodeIds: [drawStart, nodeId],
                sectionId: model.sections.find((s) => s.kind === "BEAM")?.id ?? null,
              },
            });
            setDrawStart(nodeId); // chain: keep drawing beams from the last point
          }
          break;
        }
        case "DRAW_COLUMN": {
          const topNodeId = ensureNode(snap);
          let bottomNode = findNodeBelow(snap.x, snap.y);
          if (!bottomNode) {
            const idx = model.stories.findIndex((s) => s.id === activeStory.id);
            if (idx <= 0) break; // no story below Base — nothing to found a column on
            const belowStory = model.stories[idx - 1];
            const bottomId = uid("node");
            dispatchModel({
              type: "ADD_NODE",
              payload: {
                id: bottomId,
                storyId: belowStory.id,
                gridRef: snap.gridRef,
                x: snap.x,
                y: snap.y,
                z: belowStory.elevation,
                support: belowStory.order === 0 ? "FIXED" : "FREE",
              },
            });
            bottomNode = { id: bottomId };
          }
          dispatchModel({
            type: "ADD_ELEMENT",
            payload: {
              id: uid("col"),
              kind: "COLUMN",
              storyId: activeStory.id,
              nodeIds: [bottomNode.id, topNodeId],
              sectionId: model.sections.find((s) => s.kind === "COLUMN")?.id ?? null,
            },
          });
          break;
        }
        case "DRAW_SLAB": {
          const nodeId = ensureNode(snap);
          if (slabDraft.length >= 3 && nodeId === slabDraft[0]) {
            dispatchModel({
              type: "ADD_ELEMENT",
              payload: {
                id: uid("slab"),
                kind: "SLAB",
                storyId: activeStory.id,
                boundaryNodeIds: [...slabDraft],
                sectionId: model.sections.find((s) => s.kind === "SLAB")?.id ?? null,
              },
            });
            setSlabDraft([]);
          } else {
            setSlabDraft((prev) => [...prev, nodeId]);
          }
          break;
        }
        case "DELETE":
          // handled per-entity via onClick on the element itself; tapping empty space no-ops.
          break;
        case "SELECT":
        default:
          dispatchUI({ type: "SET_SELECTION", payload: [] });
          break;
      }
    },
    [ui.activeTool, ui.snapToGrid, model, activeStory, drawStart, slabDraft, ensureNode, findNodeBelow, dispatchModel, dispatchUI, view.scale]
  );

  const deleteEntity = useCallback(
    (kind, id) => {
      if (kind === "node") dispatchModel({ type: "REMOVE_NODE", payload: { id } });
      else dispatchModel({ type: "REMOVE_ELEMENT", payload: { id } });
    },
    [dispatchModel]
  );

  /* ---------------- Pointer handling: tap / pan / pinch ---------------- */

  const onPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      dragState.current = {
        mode: "pending", // becomes "pan" if the pointer moves before release
        startX: e.clientX,
        startY: e.clientY,
        startPanX: view.panX,
        startPanY: view.panY,
      };
    } else if (pointers.current.size === 2) {
      dragState.current = { mode: "pinch" };
    }
  }, [view.panX, view.panY]);

  const onPointerMove = useCallback(
    (e) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const rect = containerRef.current.getBoundingClientRect();
      const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      setCursorWorld([wx, wy]);

      if (!dragState.current) return;

      if (dragState.current.mode === "pinch" && pointers.current.size === 2) {
        const pts = [...pointers.current.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (dragState.current.lastDist) {
          const factor = dist / dragState.current.lastDist;
          setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)) }));
        }
        dragState.current.lastDist = dist;
        return;
      }

      if (pointers.current.size === 1) {
        const dx = e.clientX - dragState.current.startX;
        const dy = e.clientY - dragState.current.startY;
        if (dragState.current.mode === "pending" && Math.hypot(dx, dy) > 6) {
          dragState.current.mode = "pan";
        }
        if (dragState.current.mode === "pan") {
          setView((v) => ({ ...v, panX: dragState.current.startPanX + dx, panY: dragState.current.startPanY + dy }));
        }
      }
    },
    [toWorld]
  );

  const onPointerUp = useCallback(
    (e) => {
      const wasPan = dragState.current && dragState.current.mode === "pan";
      const wasPinch = dragState.current && dragState.current.mode === "pinch";
      pointers.current.delete(e.pointerId);

      if (pointers.current.size === 0) {
        if (!wasPan && !wasPinch) {
          const rect = containerRef.current.getBoundingClientRect();
          const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
          handleTap(wx, wy);
        }
        dragState.current = null;
      } else if (pointers.current.size === 1) {
        // dropped from pinch back to a single finger — resume as a fresh pan anchor
        const [remaining] = pointers.current.values();
        dragState.current = {
          mode: "pending",
          startX: remaining.x,
          startY: remaining.y,
          startPanX: view.panX,
          startPanY: view.panY,
        };
      }
    },
    [handleTap, toWorld, view.panX, view.panY]
  );

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor)) }));
  }, []);

  /* ---------------- Render ---------------- */

  const gridLinesX = model.grid.xAxes;
  const gridLinesY = model.grid.yAxes;
  const worldBounds = useMemo(() => {
    const xs = gridLinesX.map((g) => g.position);
    const ys = gridLinesY.map((g) => g.position);
    const pad = 2;
    return {
      minX: (xs.length ? Math.min(...xs) : 0) - pad,
      maxX: (xs.length ? Math.max(...xs) : 10) + pad,
      minY: (ys.length ? Math.min(...ys) : 0) - pad,
      maxY: (ys.length ? Math.max(...ys) : 10) + pad,
    };
  }, [gridLinesX, gridLinesY]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 touch-none select-none bg-slate-950"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <svg width={containerSize.w} height={containerSize.h} className="block">
        {/* Grid lines */}
        <g stroke="#1e293b" strokeWidth={1}>
          {gridLinesX.map((gx) => {
            const [x1, y1] = toScreen(gx.position, worldBounds.minY);
            const [x2, y2] = toScreen(gx.position, worldBounds.maxY);
            return <line key={gx.id} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
          {gridLinesY.map((gy) => {
            const [x1, y1] = toScreen(worldBounds.minX, gy.position);
            const [x2, y2] = toScreen(worldBounds.maxX, gy.position);
            return <line key={gy.id} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>

        {/* Grid labels */}
        <g fill="#64748b" fontSize={11} fontFamily="ui-monospace, monospace">
          {gridLinesX.map((gx) => {
            const [x, y] = toScreen(gx.position, worldBounds.minY);
            return (
              <text key={gx.id} x={x} y={y + 16} textAnchor="middle">
                {gx.label}
              </text>
            );
          })}
          {gridLinesY.map((gy) => {
            const [x, y] = toScreen(worldBounds.minX, gy.position);
            return (
              <text key={gy.id} x={x - 16} y={y + 4} textAnchor="middle">
                {gy.label}
              </text>
            );
          })}
        </g>

        {/* Slabs (filled polygons, drawn under beams/columns) */}
        {storyElements
          .filter((el) => el.kind === "SLAB")
          .map((slab) => {
            const pts = slab.boundaryNodeIds
              .map((id) => nodeById.get(id))
              .filter(Boolean)
              .map((n) => toScreen(n.x, n.y).join(","))
              .join(" ");
            return (
              <polygon
                key={slab.id}
                points={pts}
                fill="#0ea5e922"
                stroke="#0ea5e9"
                strokeWidth={1}
                onClick={() => ui.activeTool === "DELETE" && deleteEntity("element", slab.id)}
                className={ui.activeTool === "DELETE" ? "cursor-pointer" : ""}
              />
            );
          })}

        {/* Beams */}
        {storyElements
          .filter((el) => el.kind === "BEAM")
          .map((beam) => {
            const a = nodeById.get(beam.nodeIds[0]);
            const b = nodeById.get(beam.nodeIds[1]);
            if (!a || !b) return null;
            const [x1, y1] = toScreen(a.x, a.y);
            const [x2, y2] = toScreen(b.x, b.y);
            return (
              <line
                key={beam.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#38bdf8"
                strokeWidth={4}
                strokeLinecap="round"
                onClick={() => ui.activeTool === "DELETE" && deleteEntity("element", beam.id)}
                className={ui.activeTool === "DELETE" ? "cursor-pointer" : ""}
              />
            );
          })}

        {/* Columns rendered in plan as a distinct square marker at the node */}
        {storyElements
          .filter((el) => el.kind === "COLUMN")
          .map((col) => {
            const top = nodeById.get(col.nodeIds[1]);
            if (!top) return null;
            const [x, y] = toScreen(top.x, top.y);
            return (
              <rect
                key={col.id}
                x={x - 7}
                y={y - 7}
                width={14}
                height={14}
                fill="#f59e0b"
                stroke="#0f172a"
                strokeWidth={1.5}
                onClick={() => ui.activeTool === "DELETE" && deleteEntity("element", col.id)}
                className={ui.activeTool === "DELETE" ? "cursor-pointer" : ""}
              />
            );
          })}

        {/* Nodes */}
        {storyNodes.map((n) => {
          const [x, y] = toScreen(n.x, n.y);
          const isDrawStart = n.id === drawStart;
          const isBase = activeStory?.order === 0;
          return (
            <g key={n.id}>
              <circle
                cx={x}
                cy={y}
                r={isDrawStart ? 6 : 4}
                fill={isDrawStart ? "#22c55e" : "#e2e8f0"}
                stroke="#0f172a"
                strokeWidth={1}
                onClick={() => ui.activeTool === "DELETE" && deleteEntity("node", n.id)}
                className={ui.activeTool === "DELETE" ? "cursor-pointer" : ""}
              />
              {isBase && n.support !== "FREE" && (
                <text x={x} y={y + 18} fontSize={9} fill="#f87171" textAnchor="middle" fontFamily="ui-monospace, monospace">
                  {n.support[0]}
                </text>
              )}
            </g>
          );
        })}

        {/* Slab-in-progress guide */}
        {slabDraft.length > 0 && (
          <polyline
            points={slabDraft
              .map((id) => nodeById.get(id))
              .filter(Boolean)
              .map((n) => toScreen(n.x, n.y).join(","))
              .join(" ")}
            fill="none"
            stroke="#a78bfa"
            strokeDasharray="4 3"
            strokeWidth={2}
          />
        )}
      </svg>

      {/* Zoom controls */}
      <div className="absolute right-3 bottom-3 flex flex-col gap-2">
        <button
          onClick={() => setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, v.scale * 1.25) }))}
          className="w-10 h-10 rounded-full bg-slate-800/90 text-slate-200 border border-slate-700 text-lg font-bold"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => setView((v) => ({ ...v, scale: Math.max(MIN_SCALE, v.scale * 0.8) }))}
          className="w-10 h-10 rounded-full bg-slate-800/90 text-slate-200 border border-slate-700 text-lg font-bold"
          aria-label="Zoom out"
        >
          −
        </button>
      </div>

      {/* Live tool hint */}
      <div className="absolute left-3 top-3 px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-700 text-[11px] text-slate-400 font-mono">
        {ui.activeTool}
        {ui.activeTool === "DRAW_SLAB" && slabDraft.length > 0 && ` · ${slabDraft.length} pts (tap start to close)`}
        {ui.activeTool === "DRAW_BEAM" && drawStart && ` · continuing chain`}
      </div>
    </div>
  );
}
