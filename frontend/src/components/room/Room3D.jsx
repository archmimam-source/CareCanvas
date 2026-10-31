/**
 * 3D scene renderer for a healthcare room.
 *
 * File layout (top → bottom):
 *   1. Palette constants  (zone tints)
 *   2. Small scene primitives — Floor, ZoneTints, Walls, Skirting
 *   3. <Items> — resolves scene.items → geometry via GeometryFor,
 *                handles wall-snapping + mount-type filtering
 *   4. <Flows> — animated particle traces (soiled / clean / person)
 *   5. <Room3DObjects> — composition of the above, also used by ArchRender3D
 *   6. <Room3D> (default export) — Canvas + camera + lighting
 */
import React, { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, ContactShadows, Html, Environment, MeshReflectorMaterial, SoftShadows } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, SMAA } from "@react-three/postprocessing";
import * as THREE from "three";
import { GeometryFor } from "./Room3DGeometry";

/* --------------------------------------------------------------------- */
/* 1. Palette                                                             */
/* --------------------------------------------------------------------- */
// Apple-refined pastel zone tints — softer, higher-key than v1.
const ZONE = {
  clean:      "#B7DDBE",
  transition: "#EBDCB6",
  dirty:      "#EDA79A",
};

/* --------------------------------------------------------------------- */
/* 2. Primitives                                                          */
/* --------------------------------------------------------------------- */
function Floor({ width, depth, shape }) {
  const notch = shape?.notch;
  return (
    <>
      <mesh receiveShadow position={[width / 2, 0, depth / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshPhysicalMaterial color="#EEEFF2" roughness={0.35} metalness={0.05}
                              clearcoat={0.6} clearcoatRoughness={0.4}
                              reflectivity={0.35} envMapIntensity={0.9} />
      </mesh>
      {notch && (
        <mesh position={[notch.x + notch.w / 2, 0.011, notch.y + notch.d / 2]}
              rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[notch.w, notch.d]} />
          <meshStandardMaterial color="#E5E5EA" roughness={0.95} transparent opacity={0.9} />
        </mesh>
      )}
    </>
  );
}

function ZoneTints({ zones, highDetail }) {
  const opacity = highDetail ? 0.88 : 0.72;
  return (
    <>
      {Object.entries(zones || {}).map(([key, z]) => (
        <mesh key={key} receiveShadow
              position={[z.x + z.w / 2, 0.005, z.y + z.d / 2]}
              rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[z.w, z.d]} />
          <meshStandardMaterial color={ZONE[key]} transparent opacity={opacity} roughness={0.9} />
        </mesh>
      ))}
      {/* Wall zone-tint strip along back wall */}
      {Object.entries(zones || {}).map(([k, z]) => (
        <mesh key={"wall-tint-" + k} position={[z.x + z.w / 2, 1.35, -0.001]}>
          <planeGeometry args={[z.w, 2.5]} />
          <meshStandardMaterial color={ZONE[k]} transparent opacity={0.22} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </>
  );
}


/**
 * Interior partitions — user-drawn thin walls. Each partition is a
 * horizontal or vertical axis-aligned segment stored in metres. Rendered
 * as a slim 2.4m-high panel with a matte finish so it reads distinctly
 * from the exterior walls.
 */
function Partitions({ partitions }) {
  if (!partitions?.length) return null;
  return (
    <group>
      {partitions.map((p) => {
        const dx = p.x2 - p.x1, dz = p.y2 - p.y1;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) return null;
        const cx = (p.x1 + p.x2) / 2;
        const cz = (p.y1 + p.y2) / 2;
        const angle = Math.atan2(dz, dx); // rotation around Y
        const H = 2.4, T = 0.06;
        return (
          <mesh key={p.id}
                position={[cx, H / 2, cz]}
                rotation={[0, -angle, 0]}
                castShadow receiveShadow>
            <boxGeometry args={[len, H, T]} />
            <meshStandardMaterial color="#E8E5DE" roughness={0.85} metalness={0.02} />
          </mesh>
        );
      })}
    </group>
  );
}

function Walls({ width, depth, shape }) {
  const notch = shape?.notch;
  const isRect = !notch || (shape?.type ?? "rectangle") === "rectangle";
  // Baseline: keep the open-L visual convention (only back + left walls) so
  // the interior stays readable in the isometric view. When an L/T/U cutout
  // exists we additionally draw the walls that trace the cutout (the two
  // "inner" edges of the notch that face into the room).
  const wall = (x, y, z, w, h, d) => (
    <mesh position={[x, y, z]} castShadow receiveShadow>
      <boxGeometry args={[w, h, d]} />
      <meshPhysicalMaterial color="#F5F5F7" roughness={0.55} metalness={0.02}
                            clearcoat={0.15} clearcoatRoughness={0.6}
                            envMapIntensity={0.6} />
    </mesh>
  );
  if (isRect) {
    return (
      <>
        {wall(width / 2, 1.3, -0.03, width + 0.06, 2.6, 0.06)}
        {wall(-0.03, 1.3, depth / 2, 0.06, 2.6, depth + 0.06)}
      </>
    );
  }
  // Compute which edge the notch touches so we can split the perimeter walls
  // around the cutout instead of running them straight past it.
  const nx  = notch.x, ny = notch.y;
  const nw  = notch.w, nd = notch.d;
  const nx2 = nx + nw, ny2 = ny + nd;
  const onTop    = ny  <= 0.001;
  const onLeft   = nx  <= 0.001;
  const onRight  = nx2 >= width  - 0.001;
  const onBottom = ny2 >= depth  - 0.001;
  const T = 0.06;   // wall thickness
  const H = 2.6;    // wall height
  const Y = 1.3;    // wall centre-Y
  const walls = [];
  // Back wall (z=0) — split if the notch touches the top edge
  if (onTop) {
    if (nx > 0.02)          walls.push(wall(nx / 2, Y, -T/2, nx + T, H, T));
    if (nx2 < width - 0.02) walls.push(wall((nx2 + width) / 2, Y, -T/2, (width - nx2) + T, H, T));
  } else {
    walls.push(wall(width / 2, Y, -T/2, width + T, H, T));
  }
  // Left wall (x=0) — split if the notch touches the left edge
  if (onLeft) {
    if (ny > 0.02)          walls.push(wall(-T/2, Y, ny / 2, T, H, ny + T));
    if (ny2 < depth - 0.02) walls.push(wall(-T/2, Y, (ny2 + depth) / 2, T, H, (depth - ny2) + T));
  } else {
    walls.push(wall(-T/2, Y, depth / 2, T, H, depth + T));
  }
  // Notch walls — the interior edges of the cutout that face into the room.
  // Only draw the edges NOT touching the room boundary (those are open air).
  if (!onTop)    walls.push(wall((nx + nx2) / 2, Y, ny,  nw + T, H, T));   // notch bottom edge
  if (!onBottom) walls.push(wall((nx + nx2) / 2, Y, ny2, nw + T, H, T));   // notch top edge (near front)
  if (!onLeft)   walls.push(wall(nx,  Y, (ny + ny2) / 2, T, H, nd + T));   // notch left edge
  if (!onRight)  walls.push(wall(nx2, Y, (ny + ny2) / 2, T, H, nd + T));   // notch right edge
  return <>{walls.map((w, i) => <React.Fragment key={i}>{w}</React.Fragment>)}</>;
}

function Skirting({ width, depth, shape }) {
  const notch = shape?.notch;
  const isRect = !notch || (shape?.type ?? "rectangle") === "rectangle";
  const seg = (x, y, z, w, h, d) => (
    <mesh position={[x, y, z]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color="#B3B7BD" roughness={0.6} />
    </mesh>
  );
  if (isRect) {
    return (
      <>
        {seg(width / 2, 0.075, 0.01, width, 0.15, 0.02)}
        {seg(0.01, 0.075, depth / 2, 0.02, 0.15, depth)}
      </>
    );
  }
  const nx = notch.x, ny = notch.y, nw = notch.w, nd = notch.d;
  const nx2 = nx + nw, ny2 = ny + nd;
  const onTop    = ny  <= 0.001;
  const onLeft   = nx  <= 0.001;
  const onRight  = nx2 >= width  - 0.001;
  const onBottom = ny2 >= depth  - 0.001;
  const parts = [];
  // Split back skirting
  if (onTop) {
    if (nx  > 0.02)         parts.push(seg(nx / 2, 0.075, 0.01, nx, 0.15, 0.02));
    if (nx2 < width - 0.02) parts.push(seg((nx2 + width) / 2, 0.075, 0.01, width - nx2, 0.15, 0.02));
  } else {
    parts.push(seg(width / 2, 0.075, 0.01, width, 0.15, 0.02));
  }
  if (onLeft) {
    if (ny  > 0.02)         parts.push(seg(0.01, 0.075, ny / 2, 0.02, 0.15, ny));
    if (ny2 < depth - 0.02) parts.push(seg(0.01, 0.075, (ny2 + depth) / 2, 0.02, 0.15, depth - ny2));
  } else {
    parts.push(seg(0.01, 0.075, depth / 2, 0.02, 0.15, depth));
  }
  // Notch skirtings
  if (!onTop)    parts.push(seg((nx + nx2) / 2, 0.075, ny  - 0.01, nw, 0.15, 0.02));
  if (!onBottom) parts.push(seg((nx + nx2) / 2, 0.075, ny2 + 0.01, nw, 0.15, 0.02));
  if (!onLeft)   parts.push(seg(nx  - 0.01, 0.075, (ny + ny2) / 2, 0.02, 0.15, nd));
  if (!onRight)  parts.push(seg(nx2 + 0.01, 0.075, (ny + ny2) / 2, 0.02, 0.15, nd));
  return <>{parts.map((p, i) => <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}

/* --------------------------------------------------------------------- */
/* 3. Items                                                               */
/* --------------------------------------------------------------------- */

// Items are positioned by their on-plan footprint (x/y/w/d) and rotation.

function Items({ scene, highlightItemId, highlightIds = new Set(), onSelect, showWallItems, showCeilingItems, componentsByKey = {} }) {
  const CEIL = scene.ceiling_h || 2.7;
  return (
    <>
      {(scene.items || []).map((it) => {
        if (it.mount_type === "wall" && !showWallItems) return null;
        if (it.mount_type === "ceiling" && !showCeilingItems) return null;

        const h = it.height_m || 0.9;
        const elev = it.elevation_m || 0;
        const yBase = it.mount_type === "ceiling"
          ? Math.max(elev, CEIL - h - 0.05)
          : elev;

        // x/y/w/d are the on-plan footprint; geometry uses local dims,
        // so quarter-turns swap w/d back.
        const px = it.x + it.w / 2;
        const pz = it.y + it.d / 2;
        const quarter = ((it.rotation || 0) % 180) === 90;
        const lw = quarter ? it.d : it.w;
        const ld = quarter ? it.w : it.d;

        const kind = it.kind || "cabinet";
        const material = it.material || (kind === "bin" ? "plastic_yellow" : "laminate");
        const rotY = ((it.rotation || 0) * Math.PI) / 180;
        const isHi = highlightItemId === it.id || highlightIds.has(it.id);

        return (
          <group key={it.id}
                 position={[px, yBase, pz]}
                 rotation={[0, -rotY, 0]}
                 onClick={(e) => {
                   if (onSelect) {
                     e.stopPropagation();
                     // Shift-click extends the multi-selection (parity with 2D).
                     onSelect(it.id, { shift: !!(e.shiftKey || e.nativeEvent?.shiftKey) });
                   }
                 }}
                 onPointerOver={() => { if (onSelect) document.body.style.cursor = "pointer"; }}
                 onPointerOut={() => { if (onSelect) document.body.style.cursor = "default"; }}>
            <GeometryFor kind={kind} w={lw} d={ld} h={h} material={material} isHi={isHi} mount={it.mount_type} />
            {componentsByKey[it.component_key]?.has_override && (
              <mesh position={[lw/2 - 0.05, h + 0.06, 0]} castShadow>
                <sphereGeometry args={[0.03, 12, 8]} />
                <meshStandardMaterial color="#7C3AED" emissive="#7C3AED" emissiveIntensity={0.55} roughness={0.35} />
              </mesh>
            )}
            {isHi && (
              <>
                {/* Wireframe cage */}
                <mesh position={[0, h / 2, 0]}>
                  <boxGeometry args={[lw + 0.06, h + 0.06, ld + 0.06]} />
                  <meshBasicMaterial color="#F59E0B" wireframe />
                </mesh>
                {/* Bright ring on the floor to draw the eye */}
                <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[Math.max(it.w, it.d) * 0.55, Math.max(it.w, it.d) * 0.62, 40]} />
                  <meshBasicMaterial color="#F59E0B" transparent opacity={0.85} />
                </mesh>
                {/* Vertical bright bar above the item */}
                <mesh position={[0, h + 0.35, 0]}>
                  <cylinderGeometry args={[0.02, 0.02, 0.6, 8]} />
                  <meshBasicMaterial color="#F59E0B" />
                </mesh>
              </>
            )}
          </group>
        );
      })}
    </>
  );
}

/* --------------------------------------------------------------------- */
/* 4. Flow particles                                                      */
/* --------------------------------------------------------------------- */

function FlowParticles({ points, color, count = 6 }) {
  const particlesRef = useRef();
  const seeds = useMemo(() => new Array(count).fill(0).map((_, i) => i / count), [count]);
  useFrame((state) => {
    if (!particlesRef.current || !points || points.length < 2) return;
    const t = state.clock.getElapsedTime();
    // particlesRef.current only holds the moving spheres — the line and
    // start anchor live in a sibling group so they never get animated.
    particlesRef.current.children.forEach((mesh, i) => {
      if (i >= seeds.length) return;
      const progress = ((t * 0.35) + seeds[i]) % 1;
      const idx = Math.floor(progress * (points.length - 1));
      const next = Math.min(idx + 1, points.length - 1);
      const local = progress * (points.length - 1) - idx;
      const p0 = points[idx], p1 = points[next];
      if (!p0 || !p1) return;
      mesh.position.set(
        p0[0] + (p1[0] - p0[0]) * local,
        p0[1] + (p1[1] - p0[1]) * local,
        p0[2] + (p1[2] - p0[2]) * local,
      );
    });
  });
  // Build a continuous line geometry for the tube so users see the actual
  // routed path, not just floating dots. `depthTest={false}` and a high
  // `renderOrder` keep the line legible above every piece of furniture.
  const linePositions = useMemo(() => {
    if (!points || points.length === 0) return new Float32Array(0);
    const arr = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      arr[i * 3    ] = points[i][0];
      arr[i * 3 + 1] = points[i][1];
      arr[i * 3 + 2] = points[i][2];
    }
    return arr;
  }, [points]);

  if (!points || points.length < 2) return null;

  return (
    <group>
      {/* Static overlays: routed line + start anchor. Kept in an outer
          group so useFrame never iterates them as particles. */}
      <line renderOrder={999}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position"
                           count={points.length}
                           array={linePositions}
                           itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial color={color} linewidth={3} transparent opacity={0.95}
                           depthTest={false} depthWrite={false} />
      </line>
      <mesh position={points[0]} renderOrder={999}>
        <sphereGeometry args={[0.09, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} depthWrite={false} />
      </mesh>
      {/* Animated particles — this inner group is what useFrame walks. */}
      <group ref={particlesRef}>
        {seeds.map((_, i) => (
          <mesh key={i} renderOrder={999}>
            <sphereGeometry args={[0.055, 12, 12]} />
            <meshBasicMaterial color={color} transparent opacity={0.95}
                               depthTest={false} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Flows({ scene, overlays, flowPaths }) {
  const animate = overlays.animate ?? true;
  if (!animate) return null;

  const flows = [];
  // Prefer routed A* polylines from the validation response — they respect
  // walls, item footprints and the L/T/U cutout. Fall back to zone-centre
  // straight lines if the backend hasn't returned paths yet.
  const routed = (key) => (flowPaths || {})[key] || null;

  const addRouted = (key, colour, count) => {
    const pts = routed(key);
    if (!pts || pts.length < 2) return false;
    flows.push({
      color: colour, count,
      // Draw at ~35 cm — high enough to visually separate from the floor,
      // low enough to feel like a floor-level route indicator. depthTest is
      // disabled on the line + spheres so they're always visible.
      points: pts.map((p) => [p.x, 0.35, p.y]),
    });
    return true;
  };

  if (overlays.dirtyFlow) {
    addRouted("soiled", "#B0655A", 8);
    addRouted("waste",  "#7C6DA5", 4);
  }
  if (overlays.personFlow) {
    addRouted("person", "#B29666", 5);
  }
  if (overlays.cleanFlow) {
    addRouted("clean_supply", "#5EA773", 5);
  }
  return <>{flows.map((f, i) => <FlowParticles key={i} {...f} />)}</>;
}

/* --------------------------------------------------------------------- */
/* 5. Room3DObjects — the composition (used by ArchRender3D too)          */
/* --------------------------------------------------------------------- */
export function Room3DObjects({
  scene, highlightItemId, highlightIds, overlays = {}, flowPaths = null,
  highDetail = false, withFlows = true, onSelect, componentsByKey = {},
}) {
  if (!scene) return null;
  const showZones = overlays.zones ?? true;
  const showWallItems = overlays.wall ?? true;
  const showCeilingItems = overlays.ceiling ?? true;

  return (
    <>
      <Floor width={scene.width} depth={scene.depth} shape={scene.shape} />
      {showZones && <ZoneTints zones={scene.zones} highDetail={highDetail} />}
      <Walls width={scene.width} depth={scene.depth} shape={scene.shape} />
      <Partitions partitions={scene.partitions || []} />
      <Skirting width={scene.width} depth={scene.depth} shape={scene.shape} />
      <Items scene={scene}
             highlightItemId={highlightItemId}
             highlightIds={highlightIds instanceof Set ? highlightIds : new Set(highlightIds || [])}
             onSelect={onSelect}
             showWallItems={showWallItems}
             showCeilingItems={showCeilingItems}
             componentsByKey={componentsByKey} />
      {withFlows && <Flows scene={scene} overlays={overlays} flowPaths={flowPaths} />}
    </>
  );
}

/* --------------------------------------------------------------------- */
/* 6. Room3D (default) — Canvas + camera + lighting                       */
/* --------------------------------------------------------------------- */
export default function Room3D({ scene, highlightItemId, highlightIds, overlays, flowPaths, onSelect, componentsByKey, peers = [] }) {
  if (!scene) return null;
  const cx = scene.width / 2;
  const cz = scene.depth / 2;
  const dist = Math.max(scene.width, scene.depth) * 3.2;
  const mergedOverlays = { ...(overlays || {}), ceiling: overlays?.ceiling ?? false };

  return (
    <div style={{ position: "absolute", inset: 0 }} data-testid="room-3d-canvas">
      <Canvas
        dpr={[1, 2]}
        shadows
        camera={{ position: [cx + dist * 0.55, dist * 0.75, cz + dist * 0.55], fov: 26, near: 0.05, far: 200 }}
        gl={{ antialias: true, alpha: false,
              toneMapping: 4 /* THREE.ACESFilmicToneMapping */,
              toneMappingExposure: 1.05,
              preserveDrawingBuffer: true,
              powerPreference: "high-performance" }}
        style={{ width: "100%", height: "100%", background: "#F5F5F7" }}
      >
        {/* Studio-grade lighting — soft key + broad fill + subtle rim.
            SoftShadows widens the penumbra so contact edges look natural. */}
        <SoftShadows size={35} samples={16} focus={0.9} />
        <color attach="background" args={["#F5F5F7"]} />
        <fog attach="fog" args={["#F5F5F7", dist * 1.6, dist * 3.2]} />

        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#FFFFFF", "#DDE1E7", 0.55]} />
        {/* Key light */}
        <directionalLight
          position={[cx + 4, 10, cz + 3]} intensity={1.15} castShadow
          shadow-mapSize-width={2048} shadow-mapSize-height={2048}
          shadow-bias={-0.0004}
          shadow-camera-left={-8} shadow-camera-right={8}
          shadow-camera-top={8} shadow-camera-bottom={-8}
          shadow-camera-near={0.5} shadow-camera-far={40}
        />
        {/* Fill light */}
        <directionalLight position={[cx - 6, 6, cz - 4]} intensity={0.4} color="#DFE7F0" />
        {/* Rim light — separates furniture silhouettes from the wall */}
        <directionalLight position={[cx, 5, cz + 8]} intensity={0.55} color="#FFF6E6" />

        {/* HDRI-style environment gives PBR materials real reflections */}
        <Environment preset="apartment" background={false} environmentIntensity={0.6} />

        <OrbitControls
          target={[cx, 0.6, cz]}
          minDistance={2} maxDistance={22}
          minPolarAngle={0.15} maxPolarAngle={Math.PI / 2 - 0.05}
          enableDamping dampingFactor={0.08}
          makeDefault
        />

        {/* Contact shadows sitting under every item — soft, wide, blurred */}
        <ContactShadows position={[cx, 0.001, cz]} opacity={0.42}
          scale={Math.max(scene.width, scene.depth) * 1.7}
          blur={3.4} far={4.5} resolution={1024} frames={1} />

        {/* Reflective floor plate — subtle mirror sheen underneath the room
            so cabinets pick up soft reflections like an Apple product shot. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}
              position={[cx, -0.002, cz]}
              receiveShadow>
          <planeGeometry args={[scene.width * 2.4, scene.depth * 2.4]} />
          <MeshReflectorMaterial
            blur={[240, 100]} resolution={1024}
            mixBlur={0.7} mixStrength={0.35} mirror={0.55}
            depthScale={0.4} minDepthThreshold={0.85} maxDepthThreshold={1.0}
            color="#EEEFF3" metalness={0.1} roughness={0.9}
            depthToBlurRatioBias={0.25}
          />
        </mesh>

        <Room3DObjects
          scene={scene}
          highlightItemId={highlightItemId}
          highlightIds={highlightIds}
          overlays={mergedOverlays}
          flowPaths={flowPaths}
          onSelect={onSelect}
          componentsByKey={componentsByKey}
        />

        {/* Peer cursors — HTML overlays projected in the 3D scene at the
            floor level using the peer's plan-view metre coordinates.
            Shown for peers whose current cursor is set (from Room2D) so
            multi-user collaboration is visible in both panes. */}
        {peers && peers.map((p) => {
          if (!p?.cursor || typeof p.cursor.x !== "number" || typeof p.cursor.y !== "number") return null;
          const key = p.email || p.name || p.conn_id;
          const color = _peerColor3D(key);
          return (
            <group key={p.conn_id}
                   position={[p.cursor.x, 0.02, p.cursor.y]}
                   data-testid={`peer-cursor-3d-${p.conn_id}`}>
              {/* Bright ring on the floor */}
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.12, 0.18, 32]} />
                <meshBasicMaterial color={color} transparent opacity={0.85} />
              </mesh>
              <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[0.11, 24]} />
                <meshBasicMaterial color={color} transparent opacity={0.35} />
              </mesh>
              {/* Vertical stalk */}
              <mesh position={[0, 0.35, 0]}>
                <cylinderGeometry args={[0.008, 0.008, 0.7, 8]} />
                <meshBasicMaterial color={color} />
              </mesh>
              {/* HTML label with "Name (Role)" pill */}
              <Html position={[0, 0.85, 0]} center distanceFactor={6}
                    style={{ pointerEvents: "none" }}>
                <div
                  style={{
                    background: color, color: "white",
                    padding: "3px 8px", borderRadius: 999,
                    fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.25)", letterSpacing: 0.1,
                  }}>
                  {p.name || "Guest"}{p.role ? ` (${_titleCase3D(p.role)})` : ""}
                </div>
              </Html>
            </group>
          );
        })}

        {/* Subtle post-processing — bloom on the whites + SMAA smoothing +
            a slight vignette to draw the eye into the room */}
        <EffectComposer multisampling={0} enableNormalPass={false}>
          <Bloom mipmapBlur luminanceThreshold={0.72} luminanceSmoothing={0.25}
                 intensity={0.5} radius={0.6} />
          <Vignette eskil={false} offset={0.05} darkness={0.55} />
          <SMAA />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

// Stable pastel color per peer, keyed by their email / name (same palette as 2D).
const _PALETTE_3D = ["#0071E3","#34C759","#FF9500","#AF52DE","#FF2D55","#5AC8FA","#EF476F","#5856D6","#22D3EE","#F97316"];
function _peerColor3D(key = "") {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return _PALETTE_3D[h % _PALETTE_3D.length];
}
function _titleCase3D(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}
