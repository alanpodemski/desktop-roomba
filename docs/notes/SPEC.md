> Design notes written while building this with parallel Claude Code agents. Kept for the curious; some details changed later (the desktop is now a generic fake one, not a mirror of a real Mac).

# Desktop Roomba — shared spec

A browser page (Vite + three.js + Rapier2D) that looks exactly like the current macOS desktop
on this Mac, with a small robot vacuum driving around it. Desktop icons are physical furniture:
the robot bumps into them, pushes light ones, gets stuck on heavy ones, maps the room, empties
its bin at a dock. It is recorded for a short video, so the quality bar is: at a glance,
indistinguishable from the real desktop, and the robot behaves like a real one.

Post caption: "made a Roomba for my desktop. unfortunately my files are now furniture"

## Project layout

```
desktop-roomba/
  SPEC.md                 this file
  package.json            vite, three, @dimforge/rapier2d-compat
  index.html              mounts #desktop (DOM) and #gl (three canvas) and #map (coverage overlay)
  scripts/scan-mac.mjs    dev-time: reads this Mac's wallpaper, dock apps, ~/Desktop files -> public/mac/
  public/mac/             generated assets (wallpaper.jpg, icons/*.png, dock.json, desktop.json, system.json)
  public/models/          roomba.glb, dock.glb (from Blender)
  blender/                .py build scripts
  src/desktop/            fake macOS desktop (DOM + CSS). Owner: desktop agent
  src/sim/                physics + behaviour. Owner: sim agent. Framework-free, testable in node
  src/render/             three.js robot, shadows, eyes, map overlay, sound. Owner: integration agent
  src/main.js             wires desktop + sim + render
```

## Coordinates

Everything uses CSS pixels of the page, origin top-left, +y down. Angles in radians, 0 = +x,
positive = clockwise on screen. Physical scale: `PX_PER_M = 440` (robot Ø 0.34 m ≈ 150 px).
Time in seconds. The sim converts to metres internally; its public API is in CSS px.

## Sim API (`src/sim/index.js`)

```js
import { createSim } from './sim/index.js';
const sim = await createSim({
  width, height,                    // page size in px
  pxPerMeter: 440,
  seed: 1,
  dock: { x, y, angle },           // dock centre and the direction the robot drives in to dock
  walls: [{ x, y, w, h }],         // static rects: menu bar, dock bar, anything not drivable
  obstacles: [{ id, x, y, w, h, massKg }],   // desktop icons, centre + size; mass from file size
});
sim.step(dt);                      // advance (dt ≤ 1/30, sim substeps internally)
sim.setObstacleKinematic(id, x, y) // user is dragging this icon: it is kinematic until release
sim.releaseObstacle(id)
sim.setObstacles(list)             // re-sync (new files, resize)
sim.addDust(x, y, count)           // user drops crumbs
sim.emptyBinNow(); sim.sendToDock(); sim.resume();
const s = sim.getState();
```

`getState()` returns (all px / px·s⁻¹ / rad):
```js
{
  robot: { x, y, angle, vx, vy, omega, wheelL, wheelR,   // wheel surface speeds px/s
           bumper: { left, right },                        // currently pressed
           mode,            // 'spiral' | 'bounce' | 'wall' | 'spot' | 'escape' | 'stuck' | 'toDock' | 'docking' | 'docked' | 'emptying' | 'charging' | 'off'
           anger,           // 0..1, rises when stuck/boxed in, decays when free
           bin, battery,    // 0..1
           brushRpm, sideBrushRpm, suction },             // 0..1 normalised
  obstacles: [{ id, x, y, angle, asleep }],                // current physical positions (pushed by robot)
  dust: { x: Float32Array, y: Float32Array, size: Float32Array, alive: Uint8Array, count },
  coverage: { cellPx: 8, w, h, data: Uint8Array },         // 0 unvisited, 1..255 number of passes (saturating)
  obstacleMap: { cellPx: 8, w, h, data: Uint8Array },      // robot's own map of where it bumped (1) / saw wall (2), as a real robot builds it
  path: [{x,y}] | null,                                    // planned path when heading to dock
  events: [{ t, type, ...}],                               // drained each call: 'bump','stuck','unstuck','angry','dockStart','docked','emptyStart','emptyEnd','chargeEnd','pushed'(id),'dustPicked'(n)
}
```

### Behaviour and physics requirements (the point of the whole thing)

- Rapier2D world. Robot = dynamic circle, 3.6 kg, Ø 150 px. Differential drive: two wheel
  contact points ±0.115 m from centre; each wheel applies a traction force toward its target
  surface speed, limited by μ·N (so wheels *slip* when pushing something heavy — the robot
  strains, slows, and if it cannot move for ~2 s it is stuck). Max speed 0.3 m/s, accel 0.6 m/s².
- Icons = dynamic boxes with mass from the real file size (log scale: 50 g for an empty file,
  5 kg for 1 GB+, folders by content size). High rolling friction against the floor (linear
  damping) so they only move when the robot really pushes; heavy ones barely budge.
- Bumper: two sensors (left/right halves of the front 180°) from contact normals. Cliff sensors
  at the screen edges (treat page bounds as a table edge: never drive off, back up fast).
- Behaviours modelled on iRobot's: start with an outward spiral; on bump -> back off, turn away
  by a random angle (bounce), or enter wall-following along the obstacle for a while using a side
  distance sensor (ray cast); dirt-detect: dense dust triggers a tight spot-spiral; periodic
  switching. Escape ladder when stuck (wiggle, reverse-turn, long reverse, spin 180°, each
  attempt raising `anger`; after N failures mode 'stuck' and a 'stuck' event — it sits there
  with the brush off and `anger` 1). Freed when the user moves an icon.
- Coverage grid updated with the brush width (~0.2 m). Obstacle map updated at bump points and
  along wall-follow rays — this is what the UI draws as the "room map".
- Bin fills with dust picked; suction pulls dust within the intake (0.18 m wide behind the
  front) toward the centre; the side brush (right-front, spinning) flings nearby dust tangentially
  so some crumbs scatter before being collected (real Roombas do this). Dust regenerates slowly
  in random clumps; icons shed a little dust when pushed.
- When bin ≥ 1 or battery ≤ 0.15: plan a path to the dock on the obstacle map (A*), follow it,
  final approach slow and aligned to `dock.angle`, 'docked', then 'emptying' for ~8 s (bin -> 0),
  'charging' until battery ≥ 0.9 (fast for the video: ~20 s), then resume. Battery drains in
  about 4 minutes by default (`?battery=` minutes). Bin fills in roughly 2–3 minutes of cleaning.
- Deterministic given seed; `step` must never explode (clamp dt, substeps). No DOM access in sim.

## Desktop API (`src/desktop/index.js`)

```js
import { createDesktop } from './desktop/index.js';
const desk = await createDesktop(document.getElementById('desktop'));
desk.getWalls()        -> [{x,y,w,h}]         // menu bar, dock
desk.getIcons()        -> [{id, x, y, w, h, massKg, name, kind}]  // centre + size in px
desk.getDock()         -> { x, y, angle }       // where the robot dock sits (bottom-left corner area, next to the Dock)
desk.setIconPosition(id, x, y, angle)           // called every frame for icons the robot pushed
desk.onIconDragStart(cb(id)); desk.onIconDrag(cb(id, x, y)); desk.onIconDragEnd(cb(id))
desk.onResize(cb)
desk.setClock(date)                             // menu bar clock follows the real clock
```

### Fidelity requirements

Replicate THIS Mac (run `sw_vers`, `screencapture` the real desktop/menu bar/Dock as reference
and compare side by side). Current design language: Liquid Glass (translucent, refractive menu
bar and Dock with specular edges). Menu bar with Apple logo, "Finder" menus, real status items
(Wi-Fi, battery with %, Control Center, Siri, clock in the system's format and locale). Dock
with the user's real Dock apps (`defaults read com.apple.dock persistent-apps`), real app icons
extracted from the .app bundles, magnification off, running-app dots, Trash. Desktop icons:
the user's real ~/Desktop files with their real Finder icons (via a small Swift snippet using
`NSWorkspace.shared.icon(forFile:)` rendered to 256 px PNG), real names with Finder's label
style (white text, dark soft shadow, two-line truncation), Finder grid arrangement from the
right edge like Finder does, selection highlight on click, drag to move. Wallpaper: the user's
current wallpaper image (find via `osascript -e 'tell application "System Events" to get picture of current desktop'`
or the wallpaper store; fall back to the system default for this macOS). Everything that is
generated goes to `public/mac/` via `scripts/scan-mac.mjs` (`npm run scan`); the page must still
work with a built-in fallback set if the scan has not run.

## Render/integration (`src/render/`, `src/main.js`)

three.js, transparent canvas over the DOM desktop. Robot = `public/models/roomba.glb` lit by a
RoomEnvironment PMREM + one key light matching the wallpaper, soft contact shadow under it,
wheels/brushes animated from sim state, bumper visibly compresses on bump, googly eyes on top
whose pupils are physical (mass in a disc with gravity + the robot's acceleration, so they rattle
on bumps and roll when it spins), eyebrows/colour tint rising with `anger`. Dust as instanced
crumbs. Coverage/obstacle map drawn as an iRobot-app-style overlay (toggle with M): cleaned cells
light, obstacle cells dark outlines, path dashed. Sounds synthesised in WebAudio: motor hum with
rpm, bump thud, stuck beeps, dock chime, loud bin-empty roar. `?nohud` for recording. Icons the
robot pushes move via `desk.setIconPosition`.

## Blender (`blender/roomba.py`, `blender/dock.py`)

Roomba-like robot (not iRobot branded): Ø 0.34 m, 0.09 m tall, dark graphite top with a subtle
brushed finish, lighter bumper ring (separate mesh named `Bumper` so it can be animated), a
round centre button cluster (`Buttons`), small lidar turret (`Turret`), two drive wheels
(`WheelL`, `WheelR`, origin at axle) and a caster, a side brush (`SideBrush`, three bristle arms,
origin at its axis, right-front), bottom intake slot and a main roller (`Roller`). Flat
mounting spot on top for the eyes (two shallow discs named `EyeL`, `EyeR`, Ø 0.06 m). Dock:
a small wedge with a tall auto-empty bin tower, light grey, contacts on the ramp. Export glTF
binary with Draco, under 3 MB each, +Y up, origin at the robot's centre on the floor plane,
real-world metres. Render a 1200 px preview PNG of each with Cycles for review.
