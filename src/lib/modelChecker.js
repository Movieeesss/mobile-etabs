const COINCIDENT_TOLERANCE_M = 0.01;
const ZERO_LENGTH_TOLERANCE_M = 0.001;

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

export function runModelCheck(model) {
  const issues = [];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));

  // Check duplicate nodes
  for (let i = 0; i < model.nodes.length; i++) {
    for (let j = i + 1; j < model.nodes.length; j++) {
      if (model.nodes[i].storyId === model.nodes[j].storyId && dist3(model.nodes[i], model.nodes[j]) < COINCIDENT_TOLERANCE_M) {
        issues.push(makeIssue("ERROR", "DUPLICATE_NODE", `Nodes are coincident.`, [model.nodes[i].id, model.nodes[j].id]));
      }
    }
  }

  // Check zero length members
  for (const el of model.elements) {
    if (el.kind === "BEAM" || el.kind === "COLUMN") {
      const a = nodeById.get(el.nodeIds[0]);
      const b = nodeById.get(el.nodeIds[1]);
      if (a && b && dist3(a, b) < ZERO_LENGTH_TOLERANCE_M) {
        issues.push(makeIssue("ERROR", "ZERO_LENGTH_MEMBER", `${el.kind} has zero length.`, [el.id]));
      }
    }
  }

  return issues;
}
