import React, { useMemo, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, Line, Html } from "@react-three/drei";
import * as THREE from "three";

/**
 * 3D structural model viewport.
 * Coordinate mapping: model (x, y, z-elevation) -> three.js (x, z-elevation-as-up... )
 * We keep Y-up (three.js convention): three.x = model.x, three.y = model.z (elevation), three.z = model.y.
 */
function toThree(node) {
  return [node.x, node.z, node.y];
}

const COLUMN_COLOR = "#f59e0b";
const BEAM_COLOR = "#38bdf8";
const SLAB_COLOR = "#0ea5e9";
const NODE_COLOR = "#e2e8f0";
const SUPPORT_COLOR = "#f87171";

function NodeMarker({ node, isActiveStory }) {
  const pos = toThree(node);
  const isSupport = node.support !== "FREE";
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshStandardMaterial
          color={isSupport ? SUPPORT_COLOR : NODE_COLOR}
          opacity={isActiveStory ? 1 : 0.35}
          transparent
        />
      </mesh>
      {isSupport && (
        <mesh position={[0, -0.12, 0]} rotation={[0, 0, 0]}>
          <coneGeometry args={[0.09, 0.18, 4]} />
          <meshStandardMaterial color={SUPPORT_COLOR} opacity={isActiveStory ? 0.9 : 0.25} transparent />
        </mesh>
      )}
    </group>
  );
}

/** A beam or column rendered as an oriented box between two nodes, sized from its section (mm -> m). */
function FrameMember({ a, b, section, kind, isActiveStory, highlighted }) {
  const { position, quaternion, length } = useMemo(() => {
    const start = new THREE.Vector3(...toThree(a));
    const end = new THREE.Vector3(...toThree(b));
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize()
    );
    return { position: mid, quaternion: quat, length: len };
  }, [a, b]);

  const widthM = ((section?.b ?? 230) / 1000) || 0.23;
  const depthM = ((section?.d ?? section?.D ?? 450) / 1000) || 0.45;
  const color = kind === "COLUMN" ? COLUMN_COLOR : BEAM_COLOR;

  return (
    <mesh position={position} quaternion={quaternion}>
      <boxGeometry args={[widthM, length, depthM]} />
      <meshStandardMaterial
        color={highlighted ? "#22c55e" : color}
        opacity={isActiveStory ? 1 : 0.25}
        transparent
        roughness={0.6}
        metalness={0.05}
      />
    </mesh>
  );
}

function SlabPanel({ nodes, isActiveStory }) {
  const shape = useMemo(() => {
    if (nodes.length < 3) return null;
    const s = new THREE.Shape();
    // Slab lies in the model XY plane at a fixed elevation; project onto (x, y) for the shape,
    // then rotate the mesh flat (X-Z plane in three.js) at render time.
    s.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length; i++) s.lineTo(nodes[i].x, nodes[i].y);
    s.closePath();
    return s;
  }, [nodes]);

  if (!shape) return null;
  const elevation = nodes[0].z;

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, elevation, 0]}>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial
        color={SLAB_COLOR}
        opacity={isActiveStory ? 0.35 : 0.1}
        transparent
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function GridLinesAtStory({ grid, elevation, opacity }) {
  const xs = grid.xAxes;
  const ys = grid.yAxes;
  if (!xs.length || !ys.length) return null;
  const minY = Math.min(...ys.map((g) => g.position));
  const maxY = Math.max(...ys.map((g) => g.position));
  const minX = Math.min(...xs.map((g) => g.position));
  const maxX = Math.max(...xs.map((g) => g.position));

  return (
    <group>
      {xs.map((gx) => (
        <Line
          key={gx.id}
          points={[
            [gx.position, elevation, minY],
            [gx.position, elevation, maxY],
          ]}
          color="#334155"
          lineWidth={1}
          transparent
          opacity={opacity}
        />
      ))}
      {ys.map((gy) => (
        <Line
          key={gy.id}
          points={[
            [minX, elevation, gy.position],
            [maxX, elevation, gy.position],
          ]}
          color="#334155"
          lineWidth={1}
          transparent
          opacity={opacity}
        />
      ))}
    </group>
  );
}

function SceneContents({ model, activeStory }) {
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  const sectionById = useMemo(() => new Map(model.sections.map((s) => [s.id, s])), [model.sections]);

  return (
    <>
      {model.stories.map((story) => (
        <GridLinesAtStory
          key={story.id}
          grid={model.grid}
          elevation={story.elevation}
          opacity={story.id === activeStory?.id ? 0.9 : 0.25}
        />
      ))}

      {model.nodes.map((n) => (
        <NodeMarker key={n.id} node={n} isActiveStory={n.storyId === activeStory?.id} />
      ))}

      {model.elements
        .filter((el) => el.kind === "BEAM" || el.kind === "COLUMN")
        .map((el) => {
          const a = nodeById.get(el.nodeIds[0]);
          const b = nodeById.get(el.nodeIds[1]);
          if (!a || !b) return null;
          return (
            <FrameMember
              key={el.id}
              a={a}
              b={b}
              section={sectionById.get(el.sectionId)}
              kind={el.kind}
              isActiveStory={el.storyId === activeStory?.id}
            />
          );
        })}

      {model.elements
        .filter((el) => el.kind === "SLAB")
        .map((el) => {
          const nodes = el.boundaryNodeIds.map((id) => nodeById.get(id)).filter(Boolean);
          if (nodes.length < 3) return null;
          return <SlabPanel key={el.id} nodes={nodes} isActiveStory={el.storyId === activeStory?.id} />;
        })}
    </>
  );
}

function EmptyModelHint() {
  return (
    <Html center>
      <div className="px-3 py-2 rounded-lg bg-slate-900/90 border border-slate-700 text-slate-400 text-xs whitespace-nowrap">
        Draw a grid and some elements in 2D Plan to see the 3D model
      </div>
    </Html>
  );
}

export default function Viewport3D({ model, ui, activeStory }) {
  const hasGeometry = model.nodes.length > 0;
  const center = useMemo(() => {
    if (!model.nodes.length) return [0, 1.5, 0];
    const avg = model.nodes.reduce(
      (acc, n) => [acc[0] + n.x, acc[1] + n.z, acc[2] + n.y],
      [0, 0, 0]
    );
    const n = model.nodes.length;
    return [avg[0] / n, avg[1] / n, avg[2] / n];
  }, [model.nodes]);

  return (
    <div className="absolute inset-0 bg-slate-950">
      <Canvas
        shadows={false}
        dpr={[1, 2]}
        camera={{ position: [center[0] + 12, center[1] + 10, center[2] + 12], fov: 45 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#020617"]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 8]} intensity={0.8} />
        <directionalLight position={[-10, 8, -8]} intensity={0.3} />

        <Suspense fallback={null}>
          {hasGeometry ? <SceneContents model={model} activeStory={activeStory} /> : <EmptyModelHint />}
        </Suspense>

        <Grid
          args={[100, 100]}
          position={[0, -0.01, 0]}
          cellColor="#1e293b"
          sectionColor="#334155"
          fadeDistance={40}
          infiniteGrid
        />

        <OrbitControls
          target={center}
          enableDamping
          dampingFactor={0.12}
          minDistance={2}
          maxDistance={150}
          touches={{ ONE: 2 /* THREE.TOUCH.ROTATE */, TWO: 4 /* THREE.TOUCH.DOLLY_PAN */ }}
        />
      </Canvas>

      <div className="absolute left-3 top-3 px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-700 text-[11px] text-slate-400 font-mono">
        Active: {activeStory?.name ?? "—"}
      </div>
    </div>
  );
}
