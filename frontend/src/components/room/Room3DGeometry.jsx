/**
 * 3D geometry catalog — one function per component kind.
 *
 * Each kind returns a <group> with props { w, d, h, material?, isHi? }.
 * All parts are anchored so the group's origin is the base-center of the item.
 * Kept intentionally declarative and flat for clarity — no cross-part maths,
 * no shared helpers except the material picker.
 */
import React from "react";

/* --------------------------------------------------------------------- */
/* Materials — a small, Apple-neutral palette (bright, low-noise)         */
/* --------------------------------------------------------------------- */
const MATERIAL = {
  stainless:     { color: "#DDE2E7", metal: 0.9,  rough: 0.22 },
  ceramic:       { color: "#FBFCFD", metal: 0.05, rough: 0.18 },
  plastic_white: { color: "#F5F5F7", metal: 0.02, rough: 0.5 },
  plastic_yellow:{ color: "#F7D14A", metal: 0.02, rough: 0.5 },
  laminate:      { color: "#E4DEC9", metal: 0.03, rough: 0.7 },
  glass:         { color: "#DFEBEF", metal: 0.02, rough: 0.08 },
  metal_grille:  { color: "#BEC3C9", metal: 0.75, rough: 0.35 },
  led:           { color: "#FCFDFE", metal: 0.02, rough: 0.18 },
  door:          { color: "#E0E0E4", metal: 0.04, rough: 0.55 },
};
const pick = (mat) => MATERIAL[mat] || MATERIAL.laminate;

/* --------------------------------------------------------------------- */
/* Face accessories — small reusable primitives per-face                  */
/* Face axes (component local, before wallRot):                           */
/*    +Z = FRONT (into room)  · −Z = BACK (against wall)                  */
/*    +Y = TOP                · 0   = BOTTOM                              */
/*    +X = RIGHT              · −X = LEFT                                 */
/* --------------------------------------------------------------------- */
function Handle({ w, y, z, size = 0.09 }) {
  return (
    <mesh position={[0, y, z]}>
      <boxGeometry args={[size, size * 0.3, size * 0.22]} />
      <meshStandardMaterial color="#B0B5BC" metalness={0.9} roughness={0.24} />
    </mesh>
  );
}
function Hinge({ x, y, z }) {
  return (
    <mesh position={[x, y, z]}>
      <cylinderGeometry args={[0.005, 0.005, 0.03, 10]} />
      <meshStandardMaterial color="#8E9198" metalness={0.9} roughness={0.28} />
    </mesh>
  );
}
function FootPedal({ w, d }) {
  // Anchored to FRONT-BOTTOM.  Ergonomic sloped pad + hinge rod.
  return (
    <group>
      <mesh position={[0, 0.02, d / 2 + 0.05]} rotation={[Math.PI / 8, 0, 0]}>
        <boxGeometry args={[w * 0.55, 0.012, 0.09]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.038, d / 2 + 0.01]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.004, 0.004, w * 0.6, 10]} />
        <meshStandardMaterial color="#8E9198" metalness={0.9} roughness={0.2} />
      </mesh>
    </group>
  );
}
function IndicatorLED({ x, y, z, color = "#6ADB7C" }) {
  return (
    <mesh position={[x, y, z]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.006, 0.006, 0.003, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
    </mesh>
  );
}
function BackPipe({ w, y, z }) {
  return (
    <mesh position={[0, y, z]}>
      <cylinderGeometry args={[0.014, 0.014, 0.14, 12]} />
      <meshStandardMaterial color="#B0B5BC" metalness={0.85} roughness={0.28} />
    </mesh>
  );
}
function CardReader({ w, y, z }) {
  return (
    <group>
      <mesh position={[0, y, z]}>
        <boxGeometry args={[0.05, 0.08, 0.012]} />
        <meshStandardMaterial color="#1D1D22" roughness={0.5} />
      </mesh>
      <mesh position={[0, y + 0.018, z + 0.007]}>
        <boxGeometry args={[0.03, 0.006, 0.006]} />
        <meshStandardMaterial color="#4C9AFF" emissive="#4C9AFF" emissiveIntensity={0.55} />
      </mesh>
    </group>
  );
}

/* --------------------------------------------------------------------- */
/* Individual kinds                                                       */
/* --------------------------------------------------------------------- */

function Macerator({ w, d, h, isHi }) {
  const m = pick("stainless");
  const bodyH = h - 0.05;
  return (
    <group>
      <mesh castShadow position={[0, 0.03, 0]}>
        <boxGeometry args={[w * 0.94, 0.06, d * 0.94]} />
        <meshStandardMaterial color="#7C8087" metalness={0.7} roughness={0.5} />
      </mesh>
      <mesh castShadow position={[0, 0.06 + bodyH / 2, 0]}>
        <boxGeometry args={[w, bodyH, d]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough}
          emissive={isHi ? "#1D1D1F" : "#000"} emissiveIntensity={isHi ? 0.3 : 0} />
      </mesh>
      {/* FRONT: LCD control panel + status LEDs */}
      <mesh position={[0, 0.06 + bodyH * 0.55, d / 2 + 0.003]}>
        <planeGeometry args={[w * 0.85, bodyH * 0.9]} />
        <meshStandardMaterial color="#C7CCD1" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.06 + bodyH * 0.88, d / 2 + 0.005]}>
        <boxGeometry args={[w * 0.55, bodyH * 0.15, 0.02]} />
        <meshStandardMaterial color="#1D1D22" roughness={0.35} />
      </mesh>
      {/* Ready / Cycle / Fault LEDs */}
      <IndicatorLED x={-w * 0.18} y={0.06 + bodyH * 0.88} z={d / 2 + 0.016} color="#6ADB7C" />
      <IndicatorLED x={0}          y={0.06 + bodyH * 0.88} z={d / 2 + 0.016} color="#F7D14A" />
      <IndicatorLED x={w * 0.18}   y={0.06 + bodyH * 0.88} z={d / 2 + 0.016} color="#E27373" />
      {/* TOP: lid with handle */}
      <mesh position={[0, h - 0.02, 0]}>
        <boxGeometry args={[w * 0.96, 0.04, d * 0.96]} />
        <meshStandardMaterial color="#B7BEC5" metalness={0.9} roughness={0.28} />
      </mesh>
      {/* TOP: exhaust vent grille */}
      <mesh position={[0, h - 0.005, -d * 0.25]}>
        <boxGeometry args={[w * 0.5, 0.008, d * 0.2]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.55} />
      </mesh>
      {/* FRONT-BOTTOM: pedal (hands-free open) */}
      <mesh position={[0, 0.03, d / 2 + 0.05]}>
        <boxGeometry args={[w * 0.35, 0.02, 0.09]} />
        <meshStandardMaterial color="#8E9198" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* BACK: water inlet + drain outlet pipes */}
      <BackPipe y={h * 0.75} z={-d / 2 - 0.02} />
      <BackPipe y={0.20}     z={-d / 2 - 0.02} />
    </group>
  );
}

function Basin({ w, d, h }) {
  const m = pick("ceramic");
  const cabH = h - 0.16;
  return (
    <group>
      {/* BACK splash panel */}
      <mesh position={[0, h + 0.15, -d / 2 + 0.01]}>
        <boxGeometry args={[w * 1.05, 0.3, 0.02]} />
        <meshStandardMaterial color="#DDE2E7" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh castShadow position={[0, cabH / 2, 0]}>
        <boxGeometry args={[w, cabH, d]} />
        <meshStandardMaterial color="#EAEAEE" roughness={0.6} />
      </mesh>
      <mesh castShadow position={[0, cabH + 0.08, 0]}>
        <boxGeometry args={[w, 0.16, d]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough} />
      </mesh>
      {/* TOP: recessed bowl */}
      <mesh position={[0, cabH + 0.13, 0.02]}>
        <boxGeometry args={[w * 0.78, 0.08, d * 0.6]} />
        <meshStandardMaterial color="#EEF2F5" roughness={0.15} />
      </mesh>
      {/* BOTTOM of bowl: drain hole */}
      <mesh position={[0, cabH + 0.17, 0.02]}>
        <cylinderGeometry args={[0.028, 0.028, 0.006, 20]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.5} />
      </mesh>
      {/* TOP-BACK: sensor tap (spout + electronic eye) */}
      <mesh position={[0, h + 0.05, -d / 2 + 0.05]}>
        <cylinderGeometry args={[0.02, 0.02, 0.22, 14]} />
        <meshStandardMaterial color="#B0B5BC" metalness={0.9} roughness={0.18} />
      </mesh>
      <mesh position={[0, h + 0.14, -d / 2 + 0.13]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.12, 12]} />
        <meshStandardMaterial color="#B0B5BC" metalness={0.9} roughness={0.18} />
      </mesh>
      {/* Sensor eye on the spout underside */}
      <mesh position={[0, h + 0.08, -d / 2 + 0.13]}>
        <sphereGeometry args={[0.007, 12, 8]} />
        <meshStandardMaterial color="#1D1D22" roughness={0.2} />
      </mesh>
      {/* BACK: waste + supply pipes emerging behind splash panel */}
      <BackPipe y={0.15} z={-d / 2 - 0.02} />
      <BackPipe y={cabH * 0.5} z={-d / 2 - 0.02} />
    </group>
  );
}

function Counter({ w, d, h }) {
  const m = pick("stainless");
  const legXs = [-w / 2 + 0.05, w / 2 - 0.05];
  const legZs = [-d / 2 + 0.05, d / 2 - 0.05];
  return (
    <group>
      {legXs.map((x) => legZs.map((z) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, (h - 0.05) / 2, z]}>
          <cylinderGeometry args={[0.022, 0.022, h - 0.05, 12]} />
          <meshStandardMaterial color="#9096A0" metalness={0.85} roughness={0.28} />
        </mesh>
      )))}
      <mesh castShadow position={[0, h * 0.35, 0]}>
        <boxGeometry args={[w * 0.95, 0.025, d * 0.9]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough + 0.1} />
      </mesh>
      <mesh castShadow position={[0, h - 0.025, 0]}>
        <boxGeometry args={[w, 0.05, d]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough} />
      </mesh>
      <mesh position={[0, h - 0.025, d / 2 + 0.008]}>
        <boxGeometry args={[w, 0.05, 0.015]} />
        <meshStandardMaterial color="#C0C5CB" metalness={0.9} roughness={0.28} />
      </mesh>
    </group>
  );
}

function Bin({ w, d, h, material = "plastic_yellow" }) {
  const m = pick(material);
  const r = Math.min(w, d) / 2;
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <cylinderGeometry args={[r, r * 0.9, h, 24]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough} />
      </mesh>
      <mesh position={[0, h * 0.15, 0]}>
        <cylinderGeometry args={[r * 0.96, r * 0.88, h * 0.05, 24]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.65} />
      </mesh>
      <mesh castShadow position={[0, h + 0.025, -r * 0.05]} rotation={[-0.1, 0, 0]}>
        <cylinderGeometry args={[r * 0.97, r * 0.97, 0.035, 24]} />
        <meshStandardMaterial color="#2A2A2F" roughness={0.55} />
      </mesh>
      {/* FRONT-BOTTOM foot pedal (foot-operated sack holder). */}
      <FootPedal w={w} d={d} />
      {/* BACK: hinge rod to the lid */}
      <mesh position={[0, h - 0.005, -r * 0.85]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.004, 0.004, r * 0.6, 10]} />
        <meshStandardMaterial color="#8E9198" metalness={0.9} roughness={0.2} />
      </mesh>
    </group>
  );
}

function Trolley({ w, d, h }) {
  const legXs = [-w / 2 + 0.05, w / 2 - 0.05];
  const legZs = [-d / 2 + 0.05, d / 2 - 0.05];
  const r = Math.min(w, d) / 2 - 0.04;
  return (
    <group>
      {legXs.map((x) => legZs.map((z) => (
        <React.Fragment key={`${x}-${z}`}>
          <mesh castShadow position={[x, (h - 0.08) / 2 + 0.04, z]}>
            <cylinderGeometry args={[0.018, 0.018, h - 0.08, 12]} />
            <meshStandardMaterial color="#D8DCE0" metalness={0.9} roughness={0.15} />
          </mesh>
          <mesh position={[x, 0.035, z]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 0.028, 14]} />
            <meshStandardMaterial color="#1D1D1F" roughness={0.7} />
          </mesh>
        </React.Fragment>
      )))}
      <mesh position={[0, h + 0.02, -d / 2 + 0.02]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.014, 0.014, w * 0.7, 12]} />
        <meshStandardMaterial color="#D8DCE0" metalness={0.9} roughness={0.15} />
      </mesh>
      <mesh castShadow position={[0, (h - 0.15) / 2 + 0.05, 0]}>
        <cylinderGeometry args={[r * 0.98, r * 0.85, h - 0.2, 20]} />
        <meshStandardMaterial color="#F1EFEA" transparent opacity={0.94} roughness={0.75} />
      </mesh>
    </group>
  );
}

function Cabinet({ w, d, h, material = "laminate", tall = false }) {
  const m = pick(material);
  const plinth = 0.08;
  const doorSplit = w > 0.55;   // twin doors on wider cabinets
  const doorTop = plinth + (h - plinth) * (tall ? 0.9 : 0.85);
  const doorBot = plinth + 0.02;
  return (
    <group>
      <mesh position={[0, plinth / 2, 0]}>
        <boxGeometry args={[w * 0.97, plinth, d * 0.97]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.55} />
      </mesh>
      <mesh castShadow position={[0, plinth + (h - plinth) / 2, 0]}>
        <boxGeometry args={[w, h - plinth, d]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough} />
      </mesh>
      {/* FRONT: door seam(s), handle(s), hinges */}
      {doorSplit && (
        <mesh position={[0, plinth + (h - plinth) / 2, d / 2 + 0.006]}>
          <boxGeometry args={[0.006, h - plinth - 0.04, 0.004]} />
          <meshStandardMaterial color="#8E9198" metalness={0.6} roughness={0.4} />
        </mesh>
      )}
      {(doorSplit ? [-w * 0.28, w * 0.28] : [w * 0.28]).map((x, i) => (
        <Handle key={`h${i}`} y={plinth + (h - plinth) * (tall ? 0.65 : 0.5)} z={d / 2 + 0.012} size={0.09} />
      ))}
      {/* Hinge dots per door: two on each vertical door edge */}
      {(doorSplit ? [-w * 0.48, w * 0.48] : [-w * 0.48]).map((x, i) => (
        <React.Fragment key={`hg${i}`}>
          <Hinge x={x} y={doorTop} z={d / 2 + 0.002} />
          <Hinge x={x} y={doorBot} z={d / 2 + 0.002} />
        </React.Fragment>
      ))}
      {/* BOTTOM: adjustable feet (only visible when the plinth is trimmed) */}
      {tall && [-w * 0.4, w * 0.4].map((x, i) => (
        <mesh key={`ft${i}`} position={[x, 0.01, 0]}>
          <cylinderGeometry args={[0.02, 0.028, 0.02, 12]} />
          <meshStandardMaterial color="#4A4D52" roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

function Dispenser({ w, d, h, material = "plastic_white" }) {
  const m = pick(material);
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={m.color} metalness={m.metal} roughness={m.rough} />
      </mesh>
      {/* FRONT: viewing window (translucent reservoir) */}
      <mesh position={[0, h * 0.62, d / 2 + 0.004]}>
        <planeGeometry args={[w * 0.55, h * 0.4]} />
        <meshStandardMaterial color="#B4CBD3" transparent opacity={0.72} roughness={0.1} />
      </mesh>
      {/* FRONT: brand label */}
      <mesh position={[0, h * 0.22, d / 2 + 0.008]}>
        <boxGeometry args={[w * 0.7, h * 0.16, 0.012]} />
        <meshStandardMaterial color="#DDE0E4" roughness={0.55} />
      </mesh>
      {/* FRONT-BOTTOM: dispensing spout */}
      <mesh position={[0, 0.04, d / 2 + 0.025]} rotation={[Math.PI / 6, 0, 0]}>
        <cylinderGeometry args={[0.009, 0.007, 0.05, 12]} />
        <meshStandardMaterial color="#8E9198" metalness={0.85} roughness={0.28} />
      </mesh>
      {/* FRONT-BOTTOM: IR sensor eye */}
      <mesh position={[0, 0.09, d / 2 + 0.006]}>
        <sphereGeometry args={[0.005, 10, 6]} />
        <meshStandardMaterial color="#1D1D22" roughness={0.2} />
      </mesh>
      {/* FRONT-BOTTOM: drip cup */}
      <mesh position={[0, 0.005, d / 2 + 0.06]}>
        <boxGeometry args={[w * 0.6, 0.008, 0.04]} />
        <meshStandardMaterial color="#B0B5BC" metalness={0.7} roughness={0.35} />
      </mesh>
    </group>
  );
}

function PPE({ w, d, h }) {
  const rows = [
    { y: 0.82, color: "#7FA9C9" },
    { y: 0.58, color: "#D9BC93" },
    { y: 0.34, color: "#E6E6EA" },
    { y: 0.12, color: "#B7C7CB" },
  ];
  return (
    <group>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#F0F0F3" roughness={0.55} />
      </mesh>
      {rows.map((r, i) => (
        <mesh key={i} position={[0, h * r.y, d / 2 + 0.006]}>
          <boxGeometry args={[w * 0.86, h * 0.16, 0.008]} />
          <meshStandardMaterial color={r.color} roughness={0.45} />
        </mesh>
      ))}
      <mesh position={[0, h * 0.97, d / 2 + 0.007]}>
        <boxGeometry args={[w * 0.98, h * 0.05, 0.006]} />
        <meshStandardMaterial color="#1D1D22" roughness={0.5} />
      </mesh>
    </group>
  );
}

function Door({ w, d, h }) {
  return (
    <group>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w * 1.04, h * 1.02, d * 1.05]} />
        <meshStandardMaterial color="#B7BEC5" roughness={0.6} />
      </mesh>
      <mesh castShadow position={[0, h / 2, d / 2 - 0.005]}>
        <boxGeometry args={[w * 0.98, h * 0.99, d * 0.7]} />
        <meshStandardMaterial color="#D8D8DC" roughness={0.5} />
      </mesh>
      {/* FRONT: viewing panel */}
      <mesh position={[0, h * 0.68, d / 2 + 0.005]}>
        <boxGeometry args={[w * 0.55, h * 0.35, 0.008]} />
        <meshStandardMaterial color="#B4CBD3" transparent opacity={0.55} roughness={0.05} metalness={0.15} />
      </mesh>
      {/* FRONT: pull rail */}
      <mesh position={[w * 0.3, h * 0.45, d / 2 + 0.006]}>
        <boxGeometry args={[w * 0.14, h * 0.3, 0.006]} />
        <meshStandardMaterial color="#B0B5BC" metalness={0.85} roughness={0.28} />
      </mesh>
      {/* FRONT: staff-card reader (hands-free entry) */}
      <CardReader w={w} y={h * 0.55} z={d / 2 + 0.009} />
      {/* FRONT-BOTTOM: kick plate */}
      <mesh position={[0, h * 0.06, d / 2 + 0.006]}>
        <boxGeometry args={[w * 0.96, h * 0.09, 0.005]} />
        <meshStandardMaterial color="#B7BEC5" metalness={0.75} roughness={0.28} />
      </mesh>
      {/* TOP: sliding rail */}
      <mesh position={[0, h + 0.02, 0]}>
        <boxGeometry args={[w * 1.1, 0.04, 0.03]} />
        <meshStandardMaterial color="#8E9198" metalness={0.85} roughness={0.28} />
      </mesh>
    </group>
  );
}

function Shelf({ w, d, h }) {
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#DDE2E7" metalness={0.65} roughness={0.32} />
      </mesh>
      <mesh position={[0, h / 2, d / 2 + 0.003]}>
        <boxGeometry args={[w, h * 1.05, 0.005]} />
        <meshStandardMaterial color="#B7BEC5" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Panel({ w, d, h }) {
  return (
    <mesh castShadow position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color="#D4C6A8" roughness={0.65} />
    </mesh>
  );
}

function Vent({ w, d, h, mount }) {
  // Ceiling-mounted vents render the louvre grille on the *underside*.
  const grilleY = mount === "ceiling" ? 0.002 : h - 0.008;
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#F0F0F3" roughness={0.5} />
      </mesh>
      <mesh position={[0, grilleY, 0]}>
        <boxGeometry args={[w * 0.92, 0.005, d * 0.92]} />
        <meshStandardMaterial color="#3A3D42" roughness={0.5} />
      </mesh>
      {Array.from({ length: 9 }).map((_, i) => {
        const off = ((i - 4) / 9) * d * 0.85;
        return (
          <mesh key={i} position={[0, grilleY + (mount === "ceiling" ? 0.001 : 0.004), off]}>
            <boxGeometry args={[w * 0.85, 0.003, 0.006]} />
            <meshStandardMaterial color="#B3B7BD" metalness={0.7} roughness={0.35} />
          </mesh>
        );
      })}
      {mount === "ceiling" && (
        <mesh position={[0, grilleY, 0]}>
          <cylinderGeometry args={[0.006, 0.006, 0.004, 12]} />
          <meshStandardMaterial color="#6E7278" metalness={0.7} roughness={0.35} />
        </mesh>
      )}
    </group>
  );
}

function Light({ w, d, h, mount }) {
  const lensY = mount === "ceiling" ? 0.002 : h - 0.003;
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#DDE0E4" roughness={0.5} />
      </mesh>
      <mesh position={[0, lensY, 0]} rotation={mount === "ceiling" ? [Math.PI, 0, 0] : [0, 0, 0]}>
        <planeGeometry args={[w * 0.94, d * 0.94]} />
        <meshStandardMaterial color="#FFFDF3" emissive="#FFF3C4" emissiveIntensity={0.85} roughness={0.15} />
      </mesh>
    </group>
  );
}

function Tray({ w, d, h }) {
  return (
    <group>
      <mesh castShadow position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#DAE6EA" transparent opacity={0.55} roughness={0.08} metalness={0.05} />
      </mesh>
      <mesh position={[0, h, 0]}>
        <boxGeometry args={[w * 1.02, 0.006, d * 1.02]} />
        <meshStandardMaterial color="#B0B5BC" metalness={0.8} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Socket({ w, d, h }) {
  const twin = w > 0.11;
  return (
    <group>
      <mesh castShadow position={[0, h / 2, d / 2 - 0.002]}>
        <boxGeometry args={[w, h, 0.008]} />
        <meshStandardMaterial color="#F5F5F7" roughness={0.5} />
      </mesh>
      {(twin ? [-w * 0.22, w * 0.22] : [0]).map((x, i) => (
        <React.Fragment key={i}>
          <mesh position={[x - 0.012, h * 0.42, d / 2 + 0.003]}>
            <boxGeometry args={[0.006, 0.014, 0.006]} />
            <meshStandardMaterial color="#0A0A0F" />
          </mesh>
          <mesh position={[x + 0.012, h * 0.42, d / 2 + 0.003]}>
            <boxGeometry args={[0.006, 0.014, 0.006]} />
            <meshStandardMaterial color="#0A0A0F" />
          </mesh>
          <mesh position={[x, h * 0.6, d / 2 + 0.003]}>
            <boxGeometry args={[0.006, 0.016, 0.006]} />
            <meshStandardMaterial color="#0A0A0F" />
          </mesh>
        </React.Fragment>
      ))}
    </group>
  );
}

/* --------------------------------------------------------------------- */
/* Public: registry + resolver                                            */
/* --------------------------------------------------------------------- */

const REGISTRY = {
  macerator: Macerator,
  basin: Basin,
  counter: Counter,
  bin: Bin,
  trolley: Trolley,
  cabinet: Cabinet,
  cabinet_tall: (props) => <Cabinet {...props} tall />,
  dispenser: Dispenser,
  ppe: PPE,
  door: Door,
  shelf: Shelf,
  panel: Panel,
  vent: Vent,
  light: Light,
  tray: Tray,
  socket: Socket,
};

/** Resolve a component kind → React geometry. Falls back to Cabinet. */
export function GeometryFor({ kind, ...props }) {
  const Comp = REGISTRY[kind] || Cabinet;
  return <Comp {...props} />;
}
