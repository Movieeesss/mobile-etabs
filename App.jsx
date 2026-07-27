import React, { useReducer, useMemo, useCallback, useState, useEffect } from "react";
import PlanCanvas2D from "./components/2DPlanCanvas.jsx";
import Viewport3D from "./components/3DViewport.jsx";
import { runModelCheck } from "./lib/modelChecker.js";

/* ------------------------------------------------------------------ */
/*  Initial state & reducer                                            */
/*  Mirrors ProjectModel / UIState from types.ts (kept as JS here      */
/*  since App.jsx is not compiled as .tsx — swap in the typed store    */
/*  once the project is migrated to TS end-to-end).                    */
/* ------------------------------------------------------------------ */

const BASE_STORY = {
  id: "story-base",
  name: "Base",
  height: 0,
  elevation: 0,
  similarToStoryId: null,
  order: 0,
};

const initialModel = {
  id: "model-1",
  name: "Untitled Model",
  grid: { xAxes: [], yAxes: [] },
  stories: [BASE_STORY],
  sections: [],
  nodes: [],
  elements: [],
  slabLoads: [],
  combinations: [
    { id: "comb-ultimate", name: "1.5(DL + LL)", factorDL: 1.5, factorLL: 1.5, isServiceability: false },
    { id: "comb-service", name: "DL + LL (Service)", factorDL: 1.0, factorLL: 1.0, isServiceability: true },
  ],
  derivedBeamLoads: [],
  memberForces: [],
  beamDesigns: [],
  columnDesigns: [],
  validationIssues: [],
  meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), codeBasis: "IS 456:2000" },
};

const initialUI = {
  activeStoryId: "story-base",
  viewMode: "PLAN_2D",
  activeTool: "SELECT",
  snapToGrid: true,
  openSheet: null,
  selectedIds: [],
};

function modelReducer(state, action) {
  switch (action.type) {
    case "SET_MODEL":
      return { ...action.payload };
    case "ADD_STORY": {
      const stories = [...state.stories, action.payload].sort((a, b) => a.order - b.order);
      return { ...state, stories };
    }
    case "UPDATE_STORY": {
      const stories = state.stories.map((s) => (s.id === action.payload.id ? { ...s, ...action.payload } : s));
      return { ...state, stories };
    }
    case "SET_GRID":
      return { ...state, grid: action.payload };
    case "ADD_SECTION":
      return { ...state, sections: [...state.sections, action.payload] };
    case "SET_VALIDATION_ISSUES":
      return { ...state, validationIssues: action.payload };
    case "TOUCH":
      return { ...state, meta: { ...state.meta, updatedAt: new Date().toISOString() } };
    default:
      return state;
  }
}

function uiReducer(state, action) {
  switch (action.type) {
    case "SET_VIEW_MODE":
      return { ...state, viewMode: action.payload };
    case "SET_ACTIVE_STORY":
      return { ...state, activeStoryId: action.payload };
    case "SET_TOOL":
      return { ...state, activeTool: action.payload };
    case "TOGGLE_SNAP":
      return { ...state, snapToGrid: !state.snapToGrid };
    case "OPEN_SHEET":
      return { ...state, openSheet: action.payload };
    case "CLOSE_SHEET":
      return { ...state, openSheet: null };
    case "SET_SELECTION":
      return { ...state, selectedIds: action.payload };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/*  Reusable primitives                                                 */
/* ------------------------------------------------------------------ */

/** Slide-up bottom sheet. Full-width on mobile, docked panel on >=lg screens. */
function BottomSheet({ open, title, onClose, children, heightClass = "max-h-[70vh]" }) {
  return (
    <div
      className={`fixed inset-0 z-40 ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Scrim */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Sheet: bottom drawer on mobile, right-docked panel from lg breakpoint up */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute bottom-0 left-0 right-0 lg:top-0 lg:left-auto lg:right-0 lg:w-[420px]
          bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-700
          rounded-t-2xl lg:rounded-none shadow-2xl
          transition-transform duration-250 ease-out
          ${heightClass} lg:h-full lg:max-h-none flex flex-col
          ${open ? "translate-y-0 lg:translate-x-0" : "translate-y-full lg:translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div className="w-8 lg:hidden" />
          <h2 className="text-sm font-semibold tracking-wide text-slate-100 uppercase">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>
        {/* Mobile drag handle */}
        <div className="lg:hidden flex justify-center pt-2">
          <div className="w-10 h-1 rounded-full bg-slate-600" />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

function IconButton({ label, active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={!!active}
      className={`flex flex-col items-center justify-center gap-0.5 min-w-[56px] h-14 rounded-xl text-[10px] font-medium
        transition-colors
        ${active ? "bg-cyan-500/15 text-cyan-400" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"}`}
    >
      <span className="text-lg leading-none">{children}</span>
      <span className="truncate max-w-[52px]">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Sheet content stubs — wired to real forms in later iterations       */
/* ------------------------------------------------------------------ */

function GridStorySheetContent({ model, dispatchModel }) {
  return (
    <div className="space-y-4 text-slate-200 text-sm">
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">X Grid Spacing (m)</h3>
        <p className="text-slate-500 text-xs mb-2">Non-uniform spacing, e.g. 4, 3.5, 5</p>
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
          placeholder="4, 3.5, 5"
        />
      </section>
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Y Grid Spacing (m)</h3>
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
          placeholder="4, 4"
        />
      </section>
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Stories</h3>
        <ul className="space-y-2">
          {model.stories
            .slice()
            .reverse()
            .map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2"
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-slate-400">{s.height.toFixed(2)} m</span>
              </li>
            ))}
        </ul>
        <button
          className="mt-3 w-full py-2 rounded-lg border border-dashed border-slate-600 text-slate-400 hover:text-cyan-400 hover:border-cyan-500 text-sm"
          onClick={() =>
            dispatchModel({
              type: "ADD_STORY",
              payload: {
                id: `story-${model.stories.length}`,
                name: `Story ${model.stories.length}`,
                height: 3,
                elevation: 0,
                similarToStoryId: null,
                order: model.stories.length,
              },
            })
          }
        >
          + Add Story
        </button>
      </section>
    </div>
  );
}

function SectionsSheetContent() {
  const grades = ["M20", "M25", "M30", "M35"];
  const rebars = ["Fe415", "Fe500", "Fe550"];
  return (
    <div className="space-y-4 text-slate-200 text-sm">
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Concrete Grade</h3>
        <div className="flex flex-wrap gap-2">
          {grades.map((g) => (
            <button
              key={g}
              className="px-3 py-1.5 rounded-full border border-slate-600 text-xs hover:border-cyan-500 hover:text-cyan-400"
            >
              {g}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Rebar Grade</h3>
        <div className="flex flex-wrap gap-2">
          {rebars.map((r) => (
            <button
              key={r}
              className="px-3 py-1.5 rounded-full border border-slate-600 text-xs hover:border-cyan-500 hover:text-cyan-400"
            >
              {r}
            </button>
          ))}
        </div>
      </section>
      <section className="grid grid-cols-2 gap-3">
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Beam b × d (mm)</h3>
          <div className="flex gap-2">
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm" placeholder="230" />
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm" placeholder="450" />
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Column b × D (mm)</h3>
          <div className="flex gap-2">
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm" placeholder="300" />
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm" placeholder="450" />
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Slab Thickness (mm)</h3>
        <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" placeholder="150" />
      </section>
      <button className="w-full py-2.5 rounded-lg bg-cyan-500 text-slate-900 font-semibold text-sm hover:bg-cyan-400">
        Save Section
      </button>
    </div>
  );
}

function SupportsSheetContent() {
  const types = ["FIXED", "PINNED", "ROLLER", "FREE"];
  return (
    <div className="space-y-3 text-slate-200 text-sm">
      <p className="text-slate-400 text-xs">Select base joints on the plan, then choose a support type.</p>
      <div className="grid grid-cols-2 gap-2">
        {types.map((t) => (
          <button
            key={t}
            className="py-3 rounded-lg border border-slate-700 hover:border-cyan-500 hover:text-cyan-400 text-sm font-medium"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadsSheetContent() {
  return (
    <div className="space-y-4 text-slate-200 text-sm">
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Slab Surface Loads (kN/m²)</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-500">Dead Load</label>
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" placeholder="1.5" />
          </div>
          <div>
            <label className="text-xs text-slate-500">Live Load</label>
            <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" placeholder="3.0" />
          </div>
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase mb-2">Load Combination</h3>
        <div className="bg-slate-800 rounded-lg px-3 py-2 flex items-center justify-between">
          <span>1.5(DL + LL)</span>
          <span className="text-slate-500 text-xs">IS 456 Cl. 18.2.3.1</span>
        </div>
      </section>
      <button className="w-full py-2.5 rounded-lg bg-cyan-500 text-slate-900 font-semibold text-sm hover:bg-cyan-400">
        Apply to Selected Slab
      </button>
    </div>
  );
}

function ModelCheckSheetContent({ model, dispatchModel }) {
  const [running, setRunning] = useState(false);

  const handleRun = useCallback(() => {
    setRunning(true);
    // runModelCheck is synchronous in-memory validation (see modelChecker.js);
    // wrapped in a timeout so the sheet shows a brief "running" state on mobile.
    setTimeout(() => {
      const issues = runModelCheck(model);
      dispatchModel({ type: "SET_VALIDATION_ISSUES", payload: issues });
      setRunning(false);
    }, 250);
  }, [model, dispatchModel]);

  return (
    <div className="space-y-3 text-sm">
      <button
        onClick={handleRun}
        disabled={running}
        className="w-full py-2.5 rounded-lg bg-cyan-500 text-slate-900 font-semibold hover:bg-cyan-400 disabled:opacity-60"
      >
        {running ? "Checking…" : "Run Model Check"}
      </button>
      {model.validationIssues.length === 0 ? (
        <p className="text-slate-500 text-xs">No issues found yet — run a check after building your model.</p>
      ) : (
        <ul className="space-y-2">
          {model.validationIssues.map((issue) => (
            <li
              key={issue.id}
              className={`rounded-lg px-3 py-2 border text-xs ${
                issue.severity === "ERROR"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}
            >
              <span className="font-semibold">{issue.code}</span> — {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                           */
/* ------------------------------------------------------------------ */

export default function App() {
  const [model, dispatchModel] = useReducer(modelReducer, initialModel);
  const [ui, dispatchUI] = useReducer(uiReducer, initialUI);

  const activeStory = useMemo(
    () => model.stories.find((s) => s.id === ui.activeStoryId) ?? model.stories[0],
    [model.stories, ui.activeStoryId]
  );

  const errorCount = useMemo(
    () => model.validationIssues.filter((i) => i.severity === "ERROR").length,
    [model.validationIssues]
  );

  // Prevent iOS Safari rubber-band scroll from fighting the canvas gestures.
  useEffect(() => {
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overscrollBehavior = "";
    };
  }, []);

  const openSheet = useCallback((sheet) => dispatchUI({ type: "OPEN_SHEET", payload: sheet }), []);
  const closeSheet = useCallback(() => dispatchUI({ type: "CLOSE_SHEET" }), []);

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* ---------------- Top App Bar ---------------- */}
      <header className="shrink-0 flex items-center justify-between px-3 h-14 border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-cyan-400 font-bold text-lg leading-none">◧</span>
          <span className="font-semibold text-sm truncate">{model.name}</span>
        </div>

        {/* View switcher */}
        <div className="flex items-center bg-slate-800 rounded-full p-1 text-xs font-medium">
          <button
            onClick={() => dispatchUI({ type: "SET_VIEW_MODE", payload: "PLAN_2D" })}
            className={`px-3 py-1.5 rounded-full transition-colors ${
              ui.viewMode === "PLAN_2D" ? "bg-cyan-500 text-slate-900" : "text-slate-400"
            }`}
          >
            2D Plan
          </button>
          <button
            onClick={() => dispatchUI({ type: "SET_VIEW_MODE", payload: "VIEW_3D" })}
            className={`px-3 py-1.5 rounded-full transition-colors ${
              ui.viewMode === "VIEW_3D" ? "bg-cyan-500 text-slate-900" : "text-slate-400"
            }`}
          >
            3D View
          </button>
        </div>

        <button
          onClick={() => openSheet("MODEL_CHECK")}
          className="relative w-9 h-9 flex items-center justify-center rounded-full hover:bg-slate-800"
          aria-label="Check model"
        >
          ✓
          {errorCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-[10px] flex items-center justify-center font-bold">
              {errorCount}
            </span>
          )}
        </button>
      </header>

      {/* ---------------- Story Selector ---------------- */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-800 overflow-x-auto no-scrollbar">
        {model.stories
          .slice()
          .reverse()
          .map((s) => (
            <button
              key={s.id}
              onClick={() => dispatchUI({ type: "SET_ACTIVE_STORY", payload: s.id })}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                s.id === activeStory?.id
                  ? "bg-cyan-500 border-cyan-500 text-slate-900"
                  : "border-slate-700 text-slate-400 hover:text-slate-200"
              }`}
            >
              {s.name}
            </button>
          ))}
        <button
          onClick={() => openSheet("GRID_STORY")}
          className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-slate-600 text-slate-500 hover:text-cyan-400 hover:border-cyan-500"
        >
          Manage Grid / Stories
        </button>
      </div>

      {/* ---------------- Main Viewport ---------------- */}
      <main className="flex-1 min-h-0 relative bg-slate-950">
        {ui.viewMode === "PLAN_2D" ? (
          <PlanCanvas2D
            model={model}
            ui={ui}
            activeStory={activeStory}
            dispatchModel={dispatchModel}
            dispatchUI={dispatchUI}
          />
        ) : (
          <Viewport3D model={model} ui={ui} activeStory={activeStory} />
        )}
      </main>

      {/* ---------------- Bottom Toolbar ---------------- */}
      <nav className="shrink-0 border-t border-slate-800 bg-slate-900/95 backdrop-blur px-1 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between overflow-x-auto no-scrollbar">
          <IconButton label="Select" active={ui.activeTool === "SELECT"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "SELECT" })}>
            ⬚
          </IconButton>
          <IconButton label="Node" active={ui.activeTool === "DRAW_NODE"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DRAW_NODE" })}>
            •
          </IconButton>
          <IconButton label="Beam" active={ui.activeTool === "DRAW_BEAM"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DRAW_BEAM" })}>
            ╱
          </IconButton>
          <IconButton label="Column" active={ui.activeTool === "DRAW_COLUMN"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DRAW_COLUMN" })}>
            ▮
          </IconButton>
          <IconButton label="Slab" active={ui.activeTool === "DRAW_SLAB"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DRAW_SLAB" })}>
            ▦
          </IconButton>
          <IconButton label="Delete" active={ui.activeTool === "DELETE"} onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DELETE" })}>
            ⌫
          </IconButton>
          <div className="w-px h-8 bg-slate-700 mx-1 shrink-0" />
          <IconButton label="Sections" onClick={() => openSheet("SECTIONS")}>▭</IconButton>
          <IconButton label="Supports" onClick={() => openSheet("SUPPORTS")}>⏚</IconButton>
          <IconButton label="Loads" onClick={() => openSheet("LOADS")}>⬇</IconButton>
          <div className="w-px h-8 bg-slate-700 mx-1 shrink-0" />
          <button
            onClick={() => openSheet("ANALYSIS_RESULTS")}
            className="shrink-0 mx-1 px-4 h-11 self-center rounded-full bg-cyan-500 text-slate-900 text-xs font-bold hover:bg-cyan-400"
          >
            Run Analysis
          </button>
        </div>
      </nav>

      {/* ---------------- Bottom Sheets ---------------- */}
      <BottomSheet open={ui.openSheet === "GRID_STORY"} title="Grid & Story Manager" onClose={closeSheet}>
        <GridStorySheetContent model={model} dispatchModel={dispatchModel} />
      </BottomSheet>

      <BottomSheet open={ui.openSheet === "SECTIONS"} title="Sections & Materials" onClose={closeSheet}>
        <SectionsSheetContent />
      </BottomSheet>

      <BottomSheet open={ui.openSheet === "SUPPORTS"} title="Base Supports" onClose={closeSheet}>
        <SupportsSheetContent />
      </BottomSheet>

      <BottomSheet open={ui.openSheet === "LOADS"} title="Loads" onClose={closeSheet}>
        <LoadsSheetContent />
      </BottomSheet>

      <BottomSheet open={ui.openSheet === "MODEL_CHECK"} title="Check Model" onClose={closeSheet}>
        <ModelCheckSheetContent model={model} dispatchModel={dispatchModel} />
      </BottomSheet>

      <BottomSheet open={ui.openSheet === "ANALYSIS_RESULTS"} title="Analysis & Design" onClose={closeSheet}>
        <p className="text-slate-400 text-sm">
          Wired to <code className="text-cyan-400">POST /api/analyze</code> in FILE 7 (main.py) — sends the
          model, runs the frame solver + IS 456 design checks, and returns BM/SF diagrams and Ast results here.
        </p>
      </BottomSheet>
    </div>
  );
}
