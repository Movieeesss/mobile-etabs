/**
 * Mobile-ETABS — Core Data Model
 * All units: length in meters (m) unless noted; forces in kN; UDL in kN/m; pressure in kN/m^2.
 * Section dimensions (b, d, D, h) are stored in millimeters (mm) to match IS 456 convention.
 */

// ---------- Enums / literal unions ----------

export type ConcreteGrade = "M20" | "M25" | "M30" | "M35";
export type RebarGrade = "Fe415" | "Fe500" | "Fe550";
export type SupportType = "FIXED" | "PINNED" | "ROLLER" | "FREE";
export type ElementKind = "BEAM" | "COLUMN" | "SLAB";
export type ViewMode = "PLAN_2D" | "VIEW_3D";
export type DesignStatus = "PASS" | "FAIL" | "NOT_RUN" | "WARNING";

// ---------- Grid & Story ----------

/** Non-uniform grid spacing along one axis, e.g. [4, 3.5, 5] meters between consecutive lines. */
export interface GridAxis {
  id: string;
  label: string; // "A", "B", "C" (Y) or "1", "2", "3" (X)
  /** Cumulative distance from origin (0) for this grid line, in meters. */
  position: number;
}

export interface GridDefinition {
  xAxes: GridAxis[]; // ordered by position ascending
  yAxes: GridAxis[]; // ordered by position ascending
}

export interface Story {
  id: string;
  name: string; // "Base", "Plinth", "Story 1"
  /** Height of THIS story above the story below, in meters. */
  height: number;
  /** Absolute elevation of this story's top level from Base = 0, in meters (derived, cached). */
  elevation: number;
  /** If set, this story mirrors geometry/sections/loads from the referenced story id ("Similar Story"). */
  similarToStoryId: string | null;
  order: number; // 0 = Base, increasing upward
}

// ---------- Materials & Sections ----------

export interface ConcreteMaterial {
  grade: ConcreteGrade;
  fck: number; // N/mm^2 (characteristic compressive strength)
}

export interface RebarMaterial {
  grade: RebarGrade;
  fy: number; // N/mm^2 (characteristic yield strength)
}

export interface BeamSection {
  id: string;
  name: string; // e.g. "B230x450"
  kind: "BEAM";
  b: number; // mm, width
  d: number; // mm, effective/overall depth (overall depth D stored; d computed at design time)
  concreteGrade: ConcreteGrade;
  rebarGrade: RebarGrade;
}

export interface ColumnSection {
  id: string;
  name: string; // e.g. "C300x450"
  kind: "COLUMN";
  b: number; // mm, width
  D: number; // mm, depth
  concreteGrade: ConcreteGrade;
  rebarGrade: RebarGrade;
}

export interface SlabSection {
  id: string;
  name: string; // e.g. "S150"
  kind: "SLAB";
  h: number; // mm, thickness
  concreteGrade: ConcreteGrade;
  rebarGrade: RebarGrade;
}

export type Section = BeamSection | ColumnSection | SlabSection;

// ---------- Geometry: Nodes & Elements ----------

export interface Node {
  id: string;
  storyId: string;
  /** Grid intersection reference, if snapped to grid; null if a free/manual point. */
  gridRef: { xAxisId: string; yAxisId: string } | null;
  x: number; // meters, global
  y: number; // meters, global
  z: number; // meters, elevation (derived from story, but stored for solver convenience)
  support: SupportType; // FREE for all non-base / non-supported nodes
}

export interface BeamElement {
  id: string;
  kind: "BEAM";
  storyId: string;
  nodeIds: [string, string]; // start, end
  sectionId: string;
}

export interface ColumnElement {
  id: string;
  kind: "COLUMN";
  /** Columns connect a node at the story below to the coincident node at this story (vertical member). */
  storyId: string; // top story of the column
  nodeIds: [string, string]; // [bottomNodeId, topNodeId]
  sectionId: string;
}

export interface SlabElement {
  id: string;
  kind: "SLAB";
  storyId: string;
  /** Ordered boundary node ids forming the slab polygon (must lie on bounding beams). */
  boundaryNodeIds: string[];
  sectionId: string;
}

export type FrameElement = BeamElement | ColumnElement;
export type ModelElement = FrameElement | SlabElement;

// ---------- Loads ----------

export interface SlabLoad {
  slabId: string;
  deadLoad: number; // kN/m^2, superimposed (excludes self-weight, which is computed from h + density)
  liveLoad: number; // kN/m^2
}

/** Derived, computed load — not user input. Produced by the tributary-area / yield-line transfer step. */
export interface DerivedBeamUDL {
  beamId: string;
  shape: "TRIANGULAR" | "TRAPEZOIDAL" | "UNIFORM";
  /** Load ordinates in kN/m along the beam, sampled at the polygon breakpoints. */
  ordinates: { distanceFromStart: number; intensity: number }[];
  combinationId: string;
}

export interface LoadCombination {
  id: string;
  name: string; // "1.5(DL+LL)"
  factorDL: number;
  factorLL: number;
  isServiceability: boolean; // false = ultimate/factored (design), true = 1.0/1.0 service check
}

export const DEFAULT_IS456_COMBINATIONS: LoadCombination[] = [
  { id: "comb-ultimate", name: "1.5(DL + LL)", factorDL: 1.5, factorLL: 1.5, isServiceability: false },
  { id: "comb-service", name: "DL + LL (Service)", factorDL: 1.0, factorLL: 1.0, isServiceability: true },
];

// ---------- Analysis & Design Results ----------

export interface MemberForceDiagram {
  elementId: string;
  combinationId: string;
  /** Sampled stations along the member, distance from start node in meters. */
  stations: number[];
  bendingMoment: number[]; // kNm, sagging positive
  shearForce: number[]; // kN
  axialForce: number[]; // kN, compression positive (columns primarily)
}

export interface BeamDesignResult {
  elementId: string;
  combinationId: string;
  status: DesignStatus;
  isDoublyReinforced: boolean;
  astRequiredTop: number; // mm^2
  astRequiredBottom: number; // mm^2
  astMin: number; // mm^2, Cl. 26.5.1.1
  astMax: number; // mm^2, 4% of gross area
  ascRequired: number | null; // mm^2, compression steel if doubly reinforced
  shearCheck: {
    tauV: number; // N/mm^2, nominal shear stress
    tauCMax: number; // N/mm^2, Cl. 40.2.3
    tauC: number; // N/mm^2, design shear strength of concrete, Table 19
    stirrupsRequired: boolean;
    spacing: number | null; // mm, provided stirrup spacing
  };
  notes: string[];
}

export interface ColumnDesignResult {
  elementId: string;
  combinationId: string;
  status: DesignStatus;
  Pu: number; // kN, factored axial load
  Mu: number; // kNm, factored uniaxial moment (governing axis)
  steelPercentage: number; // p/fck ratio result, %
  astProvided: number; // mm^2
  astMin: number; // mm^2, 0.8% Cl. 26.5.3.1
  astMax: number; // mm^2, 6% (4% recommended practical)
  notes: string[];
}

export interface ModelValidationIssue {
  id: string;
  severity: "ERROR" | "WARNING";
  code:
    | "DUPLICATE_NODE"
    | "OVERLAPPING_MEMBER"
    | "ORPHAN_NODE"
    | "ZERO_LENGTH_MEMBER"
    | "UNSUPPORTED_BASE_JOINT";
  message: string;
  relatedIds: string[]; // node/element ids implicated
}

// ---------- Root project/model shape ----------

export interface ProjectModel {
  id: string;
  name: string;
  units: { length: "m"; force: "kN"; stress: "N/mm2" };
  grid: GridDefinition;
  stories: Story[];
  sections: Section[];
  nodes: Node[];
  elements: ModelElement[];
  slabLoads: SlabLoad[];
  combinations: LoadCombination[];
  derivedBeamLoads: DerivedBeamUDL[];
  memberForces: MemberForceDiagram[];
  beamDesigns: BeamDesignResult[];
  columnDesigns: ColumnDesignResult[];
  validationIssues: ModelValidationIssue[];
  meta: {
    createdAt: string; // ISO
    updatedAt: string; // ISO
    codeBasis: "IS 456:2000";
  };
}

// ---------- UI state (not persisted with the model) ----------

export interface UIState {
  activeStoryId: string | null;
  viewMode: ViewMode;
  activeTool: "SELECT" | "DRAW_NODE" | "DRAW_BEAM" | "DRAW_COLUMN" | "DRAW_SLAB" | "DELETE";
  snapToGrid: boolean;
  openSheet:
    | null
    | "GRID_STORY"
    | "SECTIONS"
    | "SUPPORTS"
    | "LOADS"
    | "MODEL_CHECK"
    | "ANALYSIS_RESULTS"
    | "DESIGN_RESULTS";
  selectedIds: string[];
}
