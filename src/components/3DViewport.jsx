import React, { useMemo, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";

function toThree(node) {
  return [node.x, node.z, node.y];
}

function SceneContents({ model }) {
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  return (
    <>
      {model.nodes.map((n) => (
        <mesh key={n.id} position={toThree(n)}>
          <sphereGeometry args={[0.08, 12, 12]} />
          <meshStandardMaterial color="#e2e8f0" />
        </mesh>
      ))}
      {model.elements.filter(el => el.kind === "BEAM").map((b) => {
        const n1 = nodeById.get(b.nodeIds[0]);
        const n2 = nodeById.get(b.nodeIds[1]);
        if (!n1 || !n2) return null;
        const p1 = new THREE.Vector3(...toThree(n1));
        const p2 = new THREE.Vector3(...toThree(n2));
        const mid = p1.clone().add(p2).multiplyScalar(0.5);
        const len = p1.distanceTo(p2);
        return (
          <mesh key={b.id} position={mid}>
            <boxGeometry args={[0.2, len, 0.2]} />
            <meshStandardMaterial color="#38bdf8" />
          </mesh>
        );
      })}
    </>
  );
}

export default function Viewport3D({ model }) {
  return (
    <div className="absolute inset-0 bg-slate-950">
      <Canvas camera={{ position: [10, 10, 10], fov: 45 }}>
        <color attach="background" args={["#020617"]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 8]} intensity={0.8} />
        <Suspense fallback={null}>
          <SceneContents model={model} />
        </Suspense>
        <Grid args={[100, 100]} position={[0, -0.01, 0]} cellColor="#1e293b" sectionColor="#334155" />
        <OrbitControls />
      </Canvas>
    </div>
  );
}
