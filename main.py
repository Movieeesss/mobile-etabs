from __future__ import annotations
import math
from typing import List, Literal, Optional, Tuple, Dict
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Mobile-ETABS API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to the deployed PWA origin before production use
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------- #
# IS 456:2000 material & code constants
# --------------------------------------------------------------------------- #

FCK_BY_GRADE: Dict[str, float] = {"M20": 20.0, "M25": 25.0, "M30": 30.0, "M35": 35.0}  # N/mm^2
FY_BY_GRADE: Dict[str, float] = {"Fe415": 415.0, "Fe500": 500.0, "Fe550": 550.0}  # N/mm^2

# Cl. 38.1, Table for xu,max/d (limiting neutral axis depth ratio) by steel grade
XU_MAX_BY_D: Dict[str, float] = {"Fe415": 0.48, "Fe500": 0.46, "Fe550": 0.44}

CONCRETE_DENSITY = 25.0  # kN/m^3, IS 456 / IS 875 Part 1 for RCC
NU_CONCRETE = 0.2  # Poisson's ratio, used only for an approximate shear/torsion modulus


def elastic_modulus_mpa(fck: float) -> float:
    """IS 456 Cl. 6.2.3.1: Ec = 5000 * sqrt(fck), N/mm^2."""
    return 5000.0 * math.sqrt(fck)


def rectangular_torsion_constant_mm4(b: float, d: float) -> float:
    """
    Approximate St. Venant torsion constant for a solid rectangle (Timoshenko & Goodier),
    valid for b <= d. Falls back gracefully if b > d by swapping.
    """
    if b > d:
        b, d = d, b
    ratio = b / d
    return b**3 * d * (16.0 / 3.0 - 3.36 * ratio * (1.0 - (ratio**4) / 12.0)) / 16.0 * 16.0 / 16.0


# --------------------------------------------------------------------------- #
# Pydantic schema (mirrors src/types.ts)
# --------------------------------------------------------------------------- #

class NodeIn(BaseModel):
    id: str
    storyId: str
    x: float
    y: float
    z: float
    support: Literal["FIXED", "PINNED", "ROLLER", "FREE"]


class SectionIn(BaseModel):
    id: str
    kind: Literal["BEAM", "COLUMN", "SLAB"]
    b: Optional[float] = None  # mm
    d: Optional[float] = None  # mm (beam overall depth)
    D: Optional[float] = None  # mm (column depth)
    h: Optional[float] = None  # mm (slab thickness)
    concreteGrade: Literal["M20", "M25", "M30", "M35"]
    rebarGrade: Literal["Fe415", "Fe500", "Fe550"]


class ElementIn(BaseModel):
    id: str
    kind: Literal["BEAM", "COLUMN", "SLAB"]
    storyId: str
    nodeIds: Optional[Tuple[str, str]] = None
    boundaryNodeIds: Optional[List[str]] = None
    sectionId: str


class SlabLoadIn(BaseModel):
    slabId: str
    deadLoad: float  # kN/m^2, superimposed
    liveLoad: float  # kN/m^2


class LoadCombinationIn(BaseModel):
    id: str
    name: str
    factorDL: float
    factorLL: float
    isServiceability: bool = False


class ModelIn(BaseModel):
    id: str
    name: str
    nodes: List[NodeIn]
    sections: List[SectionIn]
    elements: List[ElementIn]
    slabLoads: List[SlabLoadIn] = Field(default_factory=list)
    combinations: List[LoadCombinationIn] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Step 1 — model integrity re-check (server-side mirror of src/lib/modelChecker.js)
# --------------------------------------------------------------------------- #

def revalidate_model(model: ModelIn) -> List[str]:
    errors: List[str] = []
    node_ids = {n.id for n in model.nodes}

    for el in model.elements:
        if el.kind in ("BEAM", "COLUMN"):
            if not el.nodeIds:
                errors.append(f"{el.kind} {el.id} is missing nodeIds.")
                continue
            a, b = el.nodeIds
            if a not in node_ids or b not in node_ids:
                errors.append(f"{el.kind} {el.id} references a node id that no longer exists.")
        elif el.kind == "SLAB":
            if not el.boundaryNodeIds or len(el.boundaryNodeIds) < 3:
                errors.append(f"Slab {el.id} needs at least 3 boundary nodes.")

    base_story_id = None
    if model.nodes:
        # Base = the story with the smallest z among nodes carrying a column base.
        column_bottom_ids = {el.nodeIds[0] for el in model.elements if el.kind == "COLUMN" and el.nodeIds}
        base_nodes = [n for n in model.nodes if n.id in column_bottom_ids]
        if base_nodes:
            min_z = min(n.z for n in base_nodes)
            for n in base_nodes:
                if abs(n.z - min_z) < 1e-6 and n.support == "FREE":
                    errors.append(f"Base node {n.id} carries a column but has no support assigned.")

    return errors


# --------------------------------------------------------------------------- #
# Step 2 — tributary-area (yield-line) load transfer: slab UDL -> boundary beam UDL
# --------------------------------------------------------------------------- #

class DerivedBeamUDLOut(BaseModel):
    beamId: str
    shape: Literal["TRIANGULAR", "TRAPEZOIDAL", "UNIFORM"]
    equivalentUDL: float  # kN/m — simplified equivalent UDL for max-BM matching (Pillai & Menon method)
    peakIntensity: float  # kN/m — the actual triangular/trapezoidal peak ordinate
    combinationId: str


def transfer_slab_loads_to_beams(
    model: ModelIn, node_by_id: Dict[str, NodeIn], section_by_id: Dict[str, SectionIn]
) -> List[DerivedBeamUDLOut]:
    """
    Classic two-way yield-line (45-degree corner lines) tributary distribution for a
    rectangular slab panel: short-span boundary beams receive a triangular load,
    long-span boundary beams receive a trapezoidal load. Equivalent UDLs (for an
    identical max bending moment on a simply supported span) follow the standard
    Pillai & Menon / SP:24 coefficients:
        triangular:   w_eq = w * Lx / 3
        trapezoidal:  w_eq = w * Lx / 6 * (3 - (Lx / Ly)^2)
    Non-rectangular slabs fall back to a uniform average tributary UDL (w * A / perimeter_span).
    """
    slab_load_by_id = {sl.slabId: sl for sl in model.slabLoads}
    combos = model.combinations or [
        LoadCombinationIn(id="comb-ultimate", name="1.5(DL+LL)", factorDL=1.5, factorLL=1.5)
    ]

    beams_by_story: Dict[str, List[ElementIn]] = {}
    for el in model.elements:
        if el.kind == "BEAM":
            beams_by_story.setdefault(el.storyId, []).append(el)

    results: List[DerivedBeamUDLOut] = []

    for el in model.elements:
        if el.kind != "SLAB":
            continue
        section = section_by_id.get(el.sectionId)
        slab_load = slab_load_by_id.get(el.id)
        if not slab_load:
            continue

        boundary_nodes = [node_by_id[nid] for nid in el.boundaryNodeIds if nid in node_by_id]
        if len(boundary_nodes) < 3:
            continue

        xs = [n.x for n in boundary_nodes]
        ys = [n.y for n in boundary_nodes]
        Lx_full = max(xs) - min(xs)
        Ly_full = max(ys) - min(ys)
        Lx, Ly = min(Lx_full, Ly_full), max(Lx_full, Ly_full)
        if Lx <= 0 or Ly <= 0:
            continue

        self_weight = (section.h / 1000.0 * CONCRETE_DENSITY) if (section and section.h) else 0.0

        # Find this slab's bounding beams: beams on the same story whose endpoints both lie
        # on the slab's boundary node set (handles rectangular panels directly).
        boundary_id_set = set(el.boundaryNodeIds)
        candidate_beams = [
            b for b in beams_by_story.get(el.storyId, [])
            if b.nodeIds and b.nodeIds[0] in boundary_id_set and b.nodeIds[1] in boundary_id_set
        ]

        for combo in combos:
            w_factored = combo.factorDL * (slab_load.deadLoad + self_weight) + combo.factorLL * slab_load.liveLoad

            for beam in candidate_beams:
                a, b = node_by_id[beam.nodeIds[0]], node_by_id[beam.nodeIds[1]]
                beam_len = math.hypot(b.x - a.x, b.y - a.y)
                is_short_span_beam = abs(beam_len - Lx) < abs(beam_len - Ly)

                if is_short_span_beam:
                    w_eq = w_factored * Lx / 3.0
                    peak = w_factored * Lx / 2.0
                    shape = "TRIANGULAR"
                else:
                    ratio_sq = (Lx / Ly) ** 2
                    w_eq = w_factored * Lx / 6.0 * (3.0 - ratio_sq)
                    peak = w_factored * Lx / 2.0
                    shape = "TRAPEZOIDAL"

                results.append(
                    DerivedBeamUDLOut(
                        beamId=beam.id,
                        shape=shape,
                        equivalentUDL=round(w_eq, 3),
                        peakIntensity=round(peak, 3),
                        combinationId=combo.id,
                    )
                )

    return results


# --------------------------------------------------------------------------- #
# Step 3 — 3D direct-stiffness frame analysis
# --------------------------------------------------------------------------- #

DOF_PER_NODE = 6


def local_stiffness_matrix(E: float, G: float, A: float, Iy: float, Iz: float, J: float, L: float) -> np.ndarray:
    """12x12 local stiffness matrix for a 3D Euler-Bernoulli beam-column element.
    DOF order per node: [u, v, w, theta_x, theta_y, theta_z] (axial=u along local x)."""
    k = np.zeros((12, 12))
    EA_L = E * A / L
    GJ_L = G * J / L

    EIz = E * Iz
    EIy = E * Iy

    # Axial
    k[0, 0] = k[6, 6] = EA_L
    k[0, 6] = k[6, 0] = -EA_L

    # Torsion
    k[3, 3] = k[9, 9] = GJ_L
    k[3, 9] = k[9, 3] = -GJ_L

    # Bending about local z (in local x-y plane) -> transverse v, rotation theta_z
    k[1, 1] = k[7, 7] = 12 * EIz / L**3
    k[1, 7] = k[7, 1] = -12 * EIz / L**3
    k[1, 5] = k[5, 1] = 6 * EIz / L**2
    k[1, 11] = k[11, 1] = 6 * EIz / L**2
    k[7, 5] = k[5, 7] = -6 * EIz / L**2
    k[7, 11] = k[11, 7] = -6 * EIz / L**2
    k[5, 5] = k[11, 11] = 4 * EIz / L
    k[5, 11] = k[11, 5] = 2 * EIz / L

    # Bending about local y (in local x-z plane) -> transverse w, rotation theta_y
    k[2, 2] = k[8, 8] = 12 * EIy / L**3
    k[2, 8] = k[8, 2] = -12 * EIy / L**3
    k[2, 4] = k[4, 2] = -6 * EIy / L**2
    k[2, 10] = k[10, 2] = -6 * EIy / L**2
    k[8, 4] = k[4, 8] = 6 * EIy / L**2
    k[8, 10] = k[10, 8] = 6 * EIy / L**2
    k[4, 4] = k[10, 10] = 4 * EIy / L
    k[4, 10] = k[10, 4] = 2 * EIy / L

    return k


def transformation_matrix(a: NodeIn, b: NodeIn) -> np.ndarray:
    """12x12 block-diagonal rotation matrix (global -> local) for a 3D frame element."""
    dx, dy, dz = b.x - a.x, b.y - a.y, b.z - a.z
    L = math.sqrt(dx**2 + dy**2 + dz**2)
    ex = np.array([dx, dy, dz]) / L

    # Reference vector: global Z, unless the member is (near) vertical, then use global X.
    ref = np.array([0.0, 0.0, 1.0])
    if abs(np.dot(ex, ref)) > 0.999:
        ref = np.array([1.0, 0.0, 0.0])

    ey = np.cross(ref, ex)
    ey = ey / np.linalg.norm(ey)
    ez = np.cross(ex, ey)

    R = np.vstack([ex, ey, ez])  # 3x3
    T = np.zeros((12, 12))
    for i in range(4):
        T[3 * i : 3 * i + 3, 3 * i : 3 * i + 3] = R
    return T, L


def solve_frame(
    nodes: List[NodeIn],
    members: List[Tuple[str, str, str, SectionIn]],  # (elementId, nodeA, nodeB, section)
    member_udl: Dict[str, float],  # elementId -> factored UDL (kN/m), acting in -z (gravity)
) -> Dict[str, dict]:
    """
    Returns, per element id: end forces in local coordinates (axial, shear_y, shear_z,
    torsion, moment_y, moment_z at each end) plus max |BM| and max |SF| along the span
    (accounting for the applied UDL via fixed-end-force superposition).
    """
    node_index = {n.id: i for i, n in enumerate(nodes)}
    ndof = DOF_PER_NODE * len(nodes)
    K = np.zeros((ndof, ndof))
    F = np.zeros(ndof)

    member_geo: Dict[str, dict] = {}

    for el_id, na_id, nb_id, section in members:
        a, b = next(n for n in nodes if n.id == na_id), next(n for n in nodes if n.id == nb_id)
        fck = FCK_BY_GRADE[section.concreteGrade]
        E = elastic_modulus_mpa(fck) * 1e6  # N/mm^2 -> N/m^2 (Pa), since 1 MPa = 1e6 Pa
        G = E / (2 * (1 + NU_CONCRETE))

        b_mm = section.b or 230.0
        d_mm = section.D or section.d or 450.0
        A = (b_mm * d_mm) * 1e-6  # mm^2 -> m^2
        Iz = (b_mm * d_mm**3 / 12.0) * 1e-12  # mm^4 -> m^4 (strong axis, local z)
        Iy = (d_mm * b_mm**3 / 12.0) * 1e-12  # weak axis, local y
        J = rectangular_torsion_constant_mm4(b_mm, d_mm) * 1e-12

        T, L = transformation_matrix(a, b)
        k_local = local_stiffness_matrix(E, G, A, Iy, Iz, J, L)
        k_global = T.T @ k_local @ T

        ia, ib = node_index[na_id], node_index[nb_id]
        dofs = list(range(6 * ia, 6 * ia + 6)) + list(range(6 * ib, 6 * ib + 6))
        for i_local, i_global in enumerate(dofs):
            for j_local, j_global in enumerate(dofs):
                K[i_global, i_global if False else j_global] += k_global[i_local, j_local]

        # Fixed-end forces for a UDL w (kN/m -> N/m) acting in global -Z, resolved to local axes.
        w = member_udl.get(el_id, 0.0) * 1000.0  # kN/m -> N/m
        # Local transverse component of gravity load (projection of -Z onto local y/z axes)
        R = T[0:3, 0:3]
        global_w_vec = np.array([0.0, 0.0, -w])
        local_w = R @ global_w_vec  # [wx, wy, wz] per unit length in local axes
        wy, wz = local_w[1], local_w[2]

        fe_local = np.zeros(12)
        # UDL wz (local x-z plane, bends about local y)
        fe_local[2] += wz * L / 2
        fe_local[4] += -wz * L**2 / 12
        fe_local[8] += wz * L / 2
        fe_local[10] += wz * L**2 / 12
        # UDL wy (local x-y plane, bends about local z)
        fe_local[1] += wy * L / 2
        fe_local[5] += wy * L**2 / 12
        fe_local[7] += wy * L / 2
        fe_local[11] += -wy * L**2 / 12

        fe_global = T.T @ fe_local
        for i_local, i_global in enumerate(dofs):
            F[i_global] -= fe_global[i_local]  # equivalent joint load = -fixed end force

        member_geo[el_id] = {"L": L, "T": T, "k_local": k_local, "dofs": dofs, "w_local": (wy, wz), "fe_local": fe_local}

    # Boundary conditions
    fixed_dofs = set()
    for n in nodes:
        i = node_index[n.id]
        if n.support == "FIXED":
            fixed_dofs.update(range(6 * i, 6 * i + 6))
        elif n.support == "PINNED":
            fixed_dofs.update(range(6 * i, 6 * i + 3))  # translations only
        elif n.support == "ROLLER":
            fixed_dofs.add(6 * i + 2)  # restrain vertical (z) translation only

    free_dofs = [d for d in range(ndof) if d not in fixed_dofs]
    if not free_dofs:
        raise HTTPException(422, "Model has no free degrees of freedom — check supports.")

    K_ff = K[np.ix_(free_dofs, free_dofs)]
    F_f = F[free_dofs]

    try:
        U_f = np.linalg.solve(K_ff, F_f)
    except np.linalg.LinAlgError:
        raise HTTPException(
            422,
            "Global stiffness matrix is singular — the model is a mechanism "
            "(check for unconnected members or insufficient supports).",
        )

    U = np.zeros(ndof)
    for i, d in enumerate(free_dofs):
        U[d] = U_f[i]

    # Recover member end forces & internal diagrams
    results: Dict[str, dict] = {}
    for el_id, geo in member_geo.items():
        dofs = geo["dofs"]
        u_global = U[dofs]
        u_local = geo["T"] @ u_global
        f_local = geo["k_local"] @ u_local - geo["fe_local"] * -1  # add back fixed-end forces
        f_local = geo["k_local"] @ u_local + geo["fe_local"]

        L = geo["L"]
        wy, wz = geo["w_local"]
        stations = np.linspace(0, L, 11)

        # Strong-axis (local z bending, from wz) diagrams: V(x) = V1 - wz*x ; M(x) = M1 + V1*x - wz*x^2/2
        V1_z, M1_z = f_local[2], f_local[4]
        bending_moment = M1_z + V1_z * stations - wz * stations**2 / 2
        shear_force = V1_z - wz * stations

        results[el_id] = {
            "stations": stations.tolist(),
            "bendingMoment_kNm": (bending_moment / 1000.0).tolist(),
            "shearForce_kN": (shear_force / 1000.0).tolist(),
            "axialForce_kN": float(f_local[0] / 1000.0),
            "maxAbsMoment_kNm": float(np.max(np.abs(bending_moment)) / 1000.0),
            "maxAbsShear_kN": float(np.max(np.abs(shear_force)) / 1000.0),
        }

    return results


# --------------------------------------------------------------------------- #
# Step 4 — IS 456:2000 beam design (Annex G-1.1 / Cl. 38.1)
# --------------------------------------------------------------------------- #

class BeamDesignOut(BaseModel):
    elementId: str
    status: Literal["PASS", "FAIL", "WARNING"]
    isDoublyReinforced: bool
    astRequired: float  # mm^2 (tension)
    ascRequired: float  # mm^2 (compression, 0 if singly reinforced)
    astMin: float
    astMax: float
    tauV: float
    tauC: float
    tauCMax: float
    stirrupsRequired: bool
    notes: List[str]


def design_beam(section: SectionIn, Mu_kNm: float, Vu_kN: float, effective_cover_mm: float = 40.0) -> BeamDesignOut:
    """
    Mu, Vu are the governing (already factored) design actions for one combination.
    Ast from Annex G-1.1: Mu = 0.87 fy Ast d [1 - (Ast fy)/(b d fck)] -> solved for Ast
    via the quadratic form given in the code commentary.
    """
    notes: List[str] = []
    b = section.b
    D = section.d  # overall depth for a beam
    d = D - effective_cover_mm  # effective depth, mm
    fck = FCK_BY_GRADE[section.concreteGrade]
    fy = FY_BY_GRADE[section.rebarGrade]
    xu_max_by_d = XU_MAX_BY_D[section.rebarGrade]

    Mu = abs(Mu_kNm) * 1e6  # kNm -> Nmm
    Vu = abs(Vu_kN) * 1e3  # kN -> N

    # Limiting moment of resistance, singly reinforced (Cl. G-1.1)
    Mu_lim = 0.36 * (xu_max_by_d) * (1 - 0.42 * xu_max_by_d) * fck * b * d**2

    is_doubly = Mu > Mu_lim
    Asc = 0.0

    if not is_doubly:
        # Ast from quadratic: 0.36 fck b xu = 0.87 fy Ast  and  Mu = 0.87 fy Ast d (1 - Ast fy /(b d fck))
        # Rearranged standard closed form (SP:16 / code commentary):
        discriminant = 1 - (4.6 * Mu) / (fck * b * d**2)
        if discriminant < 0:
            notes.append("Section is inadequate even for Mu,lim — increase b or D before reinforcing.")
            discriminant = 0
        Ast = 0.5 * fck * b * d / fy * (1 - math.sqrt(discriminant))
    else:
        notes.append(
            f"Mu ({Mu_kNm:.1f} kNm) exceeds singly-reinforced limit Mu,lim "
            f"({Mu_lim / 1e6:.1f} kNm) — doubly reinforced section (Annex G-1.2)."
        )
        d_dash = effective_cover_mm  # approx compression steel cover = effective cover
        fsc = 0.87 * fy  # approx design stress in compression steel at ULS (conservative for Fe415/500)
        Mu2 = Mu - Mu_lim
        Ast_lim = 0.36 * xu_max_by_d * fck * b * d / (0.87 * fy)
        Ast2 = Mu2 / (fsc * (d - d_dash)) if (d - d_dash) > 0 else 0.0
        Asc = Mu2 / (fsc * (d - d_dash)) if (d - d_dash) > 0 else 0.0
        Ast = Ast_lim + Ast2

    Ast_min = (0.85 * b * d) / fy  # Cl. 26.5.1.1(a)
    Ast_max = 0.04 * b * D  # Cl. 26.5.1.1(b), 4% of gross area

    Ast_provided = max(Ast, Ast_min)
    if Ast_provided > Ast_max:
        notes.append("Required Ast exceeds the 4% gross-area cap (Cl. 26.5.1.1(b)) — enlarge the section.")
        status: Literal["PASS", "FAIL", "WARNING"] = "FAIL"
    elif Ast < Ast_min:
        notes.append("Governed by Ast,min (Cl. 26.5.1.1(a)), not the moment demand.")
        status = "PASS"
    else:
        status = "PASS"

    # Shear design, Cl. 40
    tau_v = Vu / (b * d)  # N/mm^2
    pt = 100 * Ast_provided / (b * d)
    pt = min(pt, 3.0)  # Table 19 is tabulated up to 3%
    # Approximate curve-fit to IS 456 Table 19 (Pillai & Menon / SP:16 fitted expression)
    tau_c = 0.85 * math.sqrt(0.8 * fck) * (math.sqrt(1 + 5 * 0.8 * pt / (6.89)) - 1) / (6 * 0.8 * pt / 6.89) if pt > 0 else 0.0
    tau_c = max(tau_c, 0.28)  # floor near IS 456 Table 19 minimum for M20 at low pt
    tau_c_max = {20: 2.8, 25: 3.1, 30: 3.5, 35: 3.7}.get(int(fck), 2.8)  # Table 20, N/mm^2

    stirrups_required = tau_v > tau_c
    if tau_v > tau_c_max:
        notes.append("tau_v exceeds tau_c,max (Table 20) — section is inadequate in shear; increase b or D.")
        status = "FAIL"

    return BeamDesignOut(
        elementId="",  # filled by caller
        status=status,
        isDoublyReinforced=is_doubly,
        astRequired=round(Ast_provided, 1),
        ascRequired=round(Asc, 1),
        astMin=round(Ast_min, 1),
        astMax=round(Ast_max, 1),
        tauV=round(tau_v, 3),
        tauC=round(tau_c, 3),
        tauCMax=round(tau_c_max, 3),
        stirrupsRequired=stirrups_required,
        notes=notes,
    )


# --------------------------------------------------------------------------- #
# Step 5 — IS 456:2000 column design (Cl. 39.3 / 39.5, SP:16-style approximation)
# --------------------------------------------------------------------------- #

class ColumnDesignOut(BaseModel):
    elementId: str
    status: Literal["PASS", "FAIL", "WARNING"]
    Pu_kN: float
    Mu_kNm: float
    steelPercentage: float
    astProvided: float
    astMin: float
    astMax: float
    notes: List[str]


def design_column(section: SectionIn, Pu_kN: float, Mu_kNm: float) -> ColumnDesignOut:
    """
    Simplified short-column design for axial load + uniaxial bending, approximating the
    SP:16 non-dimensional interaction charts with the widely used Pillai & Menon closed-form
    fit. This is NOT a substitute for full SP:16 chart verification or a strain-compatibility
    solver for irregular/heavily eccentric cases — flag those explicitly.
    """
    notes: List[str] = []
    b = section.b
    D = section.D
    fck = FCK_BY_GRADE[section.concreteGrade]
    fy = FY_BY_GRADE[section.rebarGrade]

    Ag = b * D  # mm^2
    Pu = abs(Pu_kN) * 1e3  # N
    Mu = abs(Mu_kNm) * 1e6  # Nmm

    Ast_min = 0.008 * Ag  # Cl. 26.5.3.1(a), 0.8%
    Ast_max_practical = 0.04 * Ag  # 4% recommended practical limit (code allows up to 6% at splices)

    ex_min = max(D / 500 + 20 / 30 * 0 + 20, D / 30)  # simplified Cl. 25.4 minimum eccentricity (mm), floor-guard
    e = (Mu / Pu) if Pu > 0 else 0.0
    if e < ex_min and Pu > 0:
        notes.append(f"Applied eccentricity ({e:.1f}mm) is below the Cl. 25.4 minimum ({ex_min:.1f}mm) — using the minimum.")
        Mu = max(Mu, Pu * ex_min)

    # Non-dimensional parameters (SP:16 convention)
    Pu_by_fckAg = Pu / (fck * Ag)
    Mu_by_fckAgD = Mu / (fck * Ag * D)

    # Approximate p/fck from a low-order fit to SP:16 Fe415/d'/D=0.15 chart family, then
    # clamped to code min/max — treat as a first-pass estimate pending SP:16 chart cross-check.
    p_by_fck = max(0.0, 4.2 * Mu_by_fckAgD + 1.6 * Pu_by_fckAg - 0.55)
    p_by_fck = min(p_by_fck, 0.06 * fy / fck if fy else p_by_fck)  # rough cap near 6% steel envelope

    p_percent = p_by_fck * fck  # percentage steel, p
    Ast_required = (p_percent / 100.0) * Ag
    Ast_provided = max(Ast_required, Ast_min)

    status: Literal["PASS", "FAIL", "WARNING"] = "PASS"
    if Ast_provided > Ast_max_practical:
        status = "WARNING"
        notes.append("Steel percentage exceeds the 4% practical guidance — verify against full SP:16 charts or enlarge the section.")
    if Ast_required < Ast_min:
        notes.append("Governed by Ast,min (Cl. 26.5.3.1) rather than the axial/moment demand.")

    notes.append("Interaction result is an SP:16-fit approximation — cross-check against the actual SP:16 chart for the section's d'/D before finalizing.")

    return ColumnDesignOut(
        elementId="",
        status=status,
        Pu_kN=round(Pu_kN, 2),
        Mu_kNm=round(Mu_kNm, 2),
        steelPercentage=round(p_percent, 3),
        astProvided=round(Ast_provided, 1),
        astMin=round(Ast_min, 1),
        astMax=round(Ast_max_practical, 1),
        notes=notes,
    )


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

class AnalyzeResponse(BaseModel):
    derivedBeamLoads: List[DerivedBeamUDLOut]
    beamDesigns: List[BeamDesignOut]
    columnDesigns: List[ColumnDesignOut]
    warnings: List[str]


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(model: ModelIn):
    errors = revalidate_model(model)
    if errors:
        raise HTTPException(422, {"message": "Model failed validation.", "errors": errors})

    node_by_id = {n.id: n for n in model.nodes}
    section_by_id = {s.id: s for s in model.sections}

    derived_loads = transfer_slab_loads_to_beams(model, node_by_id, section_by_id)

    # Governing (ultimate) combination for design forces
    ultimate_combo = next((c for c in model.combinations if not c.isServiceability), None)
    ultimate_combo_id = ultimate_combo.id if ultimate_combo else (model.combinations[0].id if model.combinations else "comb-ultimate")

    member_udl: Dict[str, float] = {}
    for dl in derived_loads:
        if dl.combinationId == ultimate_combo_id:
            member_udl[dl.beamId] = member_udl.get(dl.beamId, 0.0) + dl.equivalentUDL

    members = []
    for el in model.elements:
        if el.kind not in ("BEAM", "COLUMN"):
            continue
        section = section_by_id.get(el.sectionId)
        if not section or not el.nodeIds:
            continue
        members.append((el.id, el.nodeIds[0], el.nodeIds[1], section))

    warnings: List[str] = []
    beam_designs: List[BeamDesignOut] = []
    column_designs: List[ColumnDesignOut] = []

    if members and model.nodes:
        forces = solve_frame(model.nodes, members, member_udl)

        for el_id, na_id, nb_id, section in members:
            fr = forces.get(el_id)
            if not fr:
                continue
            if section.kind == "BEAM" or (section.b and section.d):
                result = design_beam(section, fr["maxAbsMoment_kNm"], fr["maxAbsShear_kN"])
                result.elementId = el_id
                beam_designs.append(result)
            elif section.kind == "COLUMN" or (section.b and section.D):
                result = design_column(section, fr["axialForce_kN"], fr["maxAbsMoment_kNm"])
                result.elementId = el_id
                column_designs.append(result)
    else:
        warnings.append("No analyzable frame members found — draw beams/columns with assigned sections first.")

    return AnalyzeResponse(
        derivedBeamLoads=derived_loads,
        beamDesigns=beam_designs,
        columnDesigns=column_designs,
        warnings=warnings,
    )


# Local dev entrypoint: `python main.py` (production should run via `uvicorn main:app`)
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
