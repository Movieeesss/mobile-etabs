import React, { useReducer, useMemo } from "react";
import PlanCanvas2D from "./components/2DPlanCanvas.jsx";
import Viewport3D from "./components/3DViewport.jsx";
import { runModelCheck } from "./lib/modelChecker.js";

const BASE_STORY = { id: "story-base", name: "Base", height: 0, elevation: 0, order: 0 };
const initialModel = {
  id: "model-1",
  name: "Mobile-ETABS Project",
  grid: { xAxes: [{ id: 'x1', position: 0, label: 'A' }, { id: 'x2', position: 5, label: 'B' }], yAxes: [{ id: 'y1', position: 0, label: '1' }, { id: 'y2', position: 5, label: '2' }] },
  stories: [BASE_STORY, { id: "story-1", name: "Story 1", height: 3, elevation: 3, order: 1 }],
  sections: [],
  nodes: [],
  elements: [],
  validationIssues: []
};

const initialUI = {
  activeStoryId: "story-base",
  viewMode: "PLAN_2D",
  activeTool: "SELECT",
};

function modelReducer(state, action) {
  switch (action.type) {
    case "ADD_NODE":
      return { ...state, nodes: [...state.nodes, action.payload] };
    case "ADD_ELEMENT":
      return { ...state, elements: [...state.elements, action.payload] };
    case "SET_VALIDATION_ISSUES":
      return { ...state, validationIssues: action.payload };
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
    default:
      return state;
  }
}

export default function App() {
  const [model, dispatchModel] = useReducer(modelReducer, initialModel);
  const [ui, dispatchUI] = useReducer(uiReducer, initialUI);

  const activeStory = useMemo(
    () => model.stories.find((s) => s.id === ui.activeStoryId) ?? model.stories[0],
    [model.stories, ui.activeStoryId]
  );

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <header className="shrink-0 flex items-center justify-between px-4 h-14 border-b border-slate-800 bg-slate-900">
        <span className="font-bold text-sm text-cyan-400">Mobile-ETABS</span>
        <div className="flex bg-slate-800 rounded-full p-1 text-xs">
          <button onClick={() => dispatchUI({ type: "SET_VIEW_MODE", payload: "PLAN_2D" })} className={`px-3 py-1 rounded-full ${ui.viewMode === "PLAN_2D" ? "bg-cyan-500 text-slate-900 font-bold" : "text-slate-400"}`}>2D Plan</button>
          <button onClick={() => dispatchUI({ type: "SET_VIEW_MODE", payload: "VIEW_3D" })} className={`px-3 py-1 rounded-full ${ui.viewMode === "VIEW_3D" ? "bg-cyan-500 text-slate-900 font-bold" : "text-slate-400"}`}>3D View</button>
        </div>
      </header>

      <div className="flex gap-2 p-2 bg-slate-900/50 border-b border-slate-800 overflow-x-auto">
        {model.stories.map((s) => (
          <button key={s.id} onClick={() => dispatchUI({ type: "SET_ACTIVE_STORY", payload: s.id })} className={`px-3 py-1 rounded text-xs border ${s.id === activeStory.id ? "bg-cyan-500 border-cyan-500 text-slate-900 font-bold" : "border-slate-700 text-slate-400"}`}>
            {s.name}
          </button>
        ))}
      </div>

      <main className="flex-1 relative">
        {ui.viewMode === "PLAN_2D" ? (
          <PlanCanvas2D model={model} ui={ui} activeStory={activeStory} dispatchModel={dispatchModel} dispatchUI={dispatchUI} />
        ) : (
          <Viewport3D model={model} ui={ui} activeStory={activeStory} />
        )}
      </main>

      <nav className="h-14 bg-slate-900 border-t border-slate-800 flex items-center justify-around px-2">
        <button onClick={() => dispatchUI({ type: "SET_TOOL", payload: "SELECT" })} className={`px-4 py-2 rounded text-xs ${ui.activeTool === "SELECT" ? "text-cyan-400 bg-slate-800" : "text-slate-400"}`}>Select</button>
        <button onClick={() => dispatchUI({ type: "SET_TOOL", payload: "DRAW_NODE" })} className={`px-4 py-2 rounded text-xs ${ui.activeTool === "DRAW_NODE" ? "text-cyan-400 bg-slate-800" : "text-slate-400"}`}>Draw Node</button>
      </nav>
    </div>
  );
}
