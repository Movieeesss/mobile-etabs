/**
 * Pre-analysis model validation ("Check Model").
 * Pure function: (model: ProjectModel) -> ModelValidationIssue[]
 * No mutation, no I/O — safe to call synchronously from the UI on demand.
 */

const COINCIDENT_TOLERANCE_M = 0.01; // 10mm — treat closer than this as the same point
const ZERO_LENGTH_TOLERANCE_M = 0.001; // 1mm

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function makeIssue(severity, code, message, relatedIds) {
  return {
    id: `issue-${code.toLowerCase()}-${relatedIds.join("_")}`,
    severity,
    code,
    message,
    relatedIds,
  };
}

/** ERROR: two or more nodes on the SAME story occupying (nearly) the same point. */
function checkDuplicateNodes(model) {
  const issues = [];
  const byStory = new Map();
  for (const n of model.nodes) {
    if (!byStory.has(n.storyId)) byStory.set(n.storyId, []);
    byStory.get(n.storyId).push(n);
  }
  for (const [, nodes] of byStory) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (dist3(nodes[i], nodes[j]) < COINCIDENT_TOLERANCE_M) {
          issues.push(
            makeIssue(
              "ERROR",
              "DUPLICATE_NODE",
              `Nodes ${nodes[i].id} and ${nodes[j].id} are coincident (< ${COINCIDENT_TOLERANCE_M * 1000}mm apart). Merge them before analysis.`,
              [nodes[i].id, nodes[j].id]
            )
          );
        }
      }
    }
  }
  return issues;
}

/** ERROR: a node that no beam, column, or slab boundary references. */
function checkOrphanNodes(model) {
  const referenced = new Set();
  for (const el of model.elements) {
    const refs = el.kind === "SLAB" ? el.boundaryNodeIds : el.nodeIds;
    refs.forEach((id) => referenced.add(id));
  }
  return model.nodes
    .filter((n) => !referenced.has(n.id))
    .map((n) =>
      makeIssue(
        "WARNING",
        "ORPHAN_NODE",
        `Node ${n.id} (story ${n.storyId}) is not connected to any beam, column, or slab.`,
        [n.id]
      )
    );
}

/** ERROR: a beam/column whose two end nodes are (nearly) coincident. */
function checkZeroLengthMembers(model, nodeById) {
  const issues = [];
  for (const el of model.elements) {
    if (el.kind !== "BEAM" && el.kind !== "COLUMN") continue;
    const a = nodeById.get(el.nodeIds[0]);
    const b = nodeById.get(el.nodeIds[1]);
    if (!a || !b) continue; // dangling reference — a different integrity problem, not flagged here
    if (dist3(a, b) < ZERO_LENGTH_TOLERANCE_M) {
      issues.push(
        makeIssue(
          "ERROR",
          "ZERO_LENGTH_MEMBER",
          `${el.kind === "BEAM" ? "Beam" : "Column"} ${el.id} has zero length — start and end nodes coincide.`,
          [el.id, a.id, b.id]
        )
      );
    }
  }
  return issues;
}

/**
 * ERROR: two frame elements of the SAME kind on the SAME story sharing both end nodes
 * (drawn twice on top of each other) — this double-stiffens the member in the solver.
 */
function checkOverlappingMembers(model) {
  const issues = [];
  const seen = new Map(); // key: `${kind}:${storyId}:${sortedNodeIds}` -> elementId

  for (const el of model.elements) {
    if (el.kind !== "BEAM" && el.kind !== "COLUMN") continue;
    const key = `${el.kind}:${el.storyId}:${[...el.nodeIds].sort().join("|")}`;
    if (seen.has(key)) {
      issues.push(
        makeIssue(
          "ERROR",
          "OVERLAPPING_MEMBER",
          `${el.kind === "BEAM" ? "Beam" : "Column"} ${el.id} duplicates ${seen.get(key)} — same end nodes on the same story.`,
          [el.id, seen.get(key)]
        )
      );
    } else {
      seen.set(key, el.id);
    }
  }
  return issues;
}

/**
 * WARNING: a node at the lowest (Base, order === 0) story that has no support assigned
 * (still FREE) but participates in a column — the model will be unstable/a mechanism.
 */
function checkUnsupportedBaseJoints(model) {
  const issues = [];
  const baseStory = model.stories.find((s) => s.order === 0);
  if (!baseStory) return issues;

  const baseNodeIds = new Set(model.nodes.filter((n) => n.storyId === baseStory.id).map((n) => n.id));
  const baseNodesInUse = new Set();
  for (const el of model.elements) {
    if (el.kind !== "COLUMN") continue;
    const [bottomId] = el.nodeIds;
    if (baseNodeIds.has(bottomId)) baseNodesInUse.add(bottomId);
  }

  for (const nodeId of baseNodesInUse) {
    const node = model.nodes.find((n) => n.id === nodeId);
    if (node && node.support === "FREE") {
      issues.push(
        makeIssue(
          "ERROR",
          "UNSUPPORTED_BASE_JOINT",
          `Base node ${node.id} carries a column but has no support (FIXED/PINNED/ROLLER) assigned.`,
          [node.id]
        )
      );
    }
  }

  if (baseNodesInUse.size === 0 && model.elements.some((el) => el.kind === "COLUMN")) {
    issues.push(
      makeIssue(
        "WARNING",
        "UNSUPPORTED_BASE_JOINT",
        `No columns land on the Base story — the model may be floating with no foundation-level supports.`,
        []
      )
    );
  }

  return issues;
}

export function runModelCheck(model) {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));

  return [
    ...checkDuplicateNodes(model),
    ...checkOverlappingMembers(model),
    ...checkOrphanNodes(model),
    ...checkZeroLengthMembers(model, nodeById),
    ...checkUnsupportedBaseJoints(model),
  ];
}

export default runModelCheck;
