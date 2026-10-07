> Design notes written while building this with parallel Claude Code agents. Kept for the curious; some details changed later (the desktop is now a generic fake one, not a mirror of a real Mac).

# Addendum: the cake incident (+ UI round 2)

Read SPEC.md first. Everything here uses the same conventions (CSS px, +y down, angle 0 = +x,
clockwise positive, PX_PER_M = 440). Several files changed since the first build (manual drive mode,
minimap, noise-only sound, fake desktop): re-read every file before editing it.

## The joke
A tall slice of chocolate layer cake stands in the middle of the desktop. The robot bumps it, the slice
tips over onto its side, the robot rides up onto it, gets hung up for a moment (wheels slipping in
frosting, body tilting, a little jolt), crushes it, and then — like the real "Roomba drove through dog
mess" videos — carries chocolate on its wheels and brush and prints smeared tracks over the whole desktop
in its normal cleaning pattern, fading as the frosting wears off. Physics must drive all of it.

## Cake model (Blender agent) — public/models/cake.glb
Slice of chocolate layer cake, standing upright on its narrow base like a slice put on a table:
wedge, 0.13 m long (tip to back), 30° tip angle (back ≈ 0.07 m wide), 0.11 m tall. Three dark sponge
layers with two glossy ganache fillings visible on both cut faces, thick chocolate frosting on the top
and the curved back, chocolate shavings and a cherry (or a chocolate curl) on top, a few crumbs.
Separate mesh names: CakeSponge, CakeFilling, CakeFrosting, CakeTopping. Origin at the centre of the
footprint on the floor, +Y up, wedge axis along −Z (tip at −Z), metres. Also a CakeSquashed mesh
(hidden by default): the same mass flattened into a messy 0.18 m blob 0.02 m high with exposed sponge
chunks, used when the robot has crushed it. Draco, < 2 MB. Cycles preview PNG.

## Sim (src/sim/mess.js + hooks in index.js / physics.js)
Config: `cake: { x, y, angle } | false` (default: page centre, random angle from seed).
API: `sim.placeCake(x, y, angle)` (new cake, old one stays crushed on the floor if it was crushed);
state `cake: { x, y, angle, phase, tip, tipDir, squash, frosting } | null`
  phase: 'standing' | 'tipping' | 'lying' | 'crushed'
  tip 0..1 (fall angle / 90°), tipDir (page angle of the direction the top falls), squash 0..1,
  frosting 0..1 left on the cake.
Robot state additions: `robot.pitch, robot.roll` (rad, + pitch = nose up), `robot.lift` (m, body raised
by what it is driving over), `robot.load` (0..1 frosting carried by wheels + brush).
Smear output, drained every getState like events: `smear: [{ kind, x, y, angle, w, amount }]`
  kind 'wheelL' | 'wheelR' | 'brush' | 'fling' | 'splat'; x,y px; angle = travel direction;
  w = stamp width px; amount 0..1 (paint thickness).
Events: 'cakeHit' {force}, 'cakeTip', 'cakeLand', 'cakeClimb', 'cakeCrush', 'smearOut' (load < 0.02).

Physics:
- Standing: dynamic Rapier box (0.13 × 0.07 m footprint, 0.35 kg, sticky floor friction μ 0.5).
  Measure the robot's contact force F and its direction. Tipping criterion about the far bottom edge:
  F · h_c > m · g · (d/2), h_c = 0.04 m (bumper height), d = footprint depth along the push. Pushed
  sideways it tips (narrow 0.07 m); pushed along its axis it mostly slides (0.13 m).
- Tipping: rigid body pivoting about that edge: φ'' = m g r sin(φ − φ0) / I (box inertia about the edge),
  integrate until it lands at 90° ('cakeLand'); a small bounce is fine. It keeps colliding while falling.
- Lying (0.13 × 0.11 footprint, 0.07 high): no longer a hard collider for the robot (a real robot rides
  onto soft things). While the robot's footprint overlaps it: extra rolling resistance, wheel traction
  μ × 0.3 (frosting), pitch/roll up to ~8° from the height under the front/sides, lift, random micro-slip
  jolts, squash += f(robot weight on it)·dt, frosting moves cake → robot.load. The existing stuck
  detector may fire and run the escape ladder; that is realistic, keep it. squash ≥ 0.9 → 'crushed'
  (emit one big 'splat' stamp and 'cakeCrush'); the crushed blob reloads the robot whenever it drives over it.
- Smear deposition every step while load > 0: per wheel (±0.115 m) a stamp along the path, amount
  ∝ load × distance; brush band 0.18 m wide, lighter and smudgier; occasional 'fling' droplets thrown
  from the right-front side brush tangentially. load decays per metre driven (exp, ~6 m length scale) so
  tracks fade over ~15–20 m; driving over existing smear re-picks a little (keep a coarse smear grid in
  the sim for that). Coverage/mapping unchanged; the lying cake is not an obstacle in the robot's map.
- Extend src/sim/test.mjs with a deterministic cake scenario (robot pushes standing cake sideways →
  tips → lands → climb → crush → smear stamps emitted over > 5 m of driving → load fades). All existing
  checks must keep passing.

## Render (integration agent)
- src/render/cake.js: cake.glb at the sim pose; tipping = rotation about the pivot edge in tipDir;
  squash = flatten height and spread, crossfade to CakeSquashed when crushed. Soft contact shadow.
- src/render/smear.js: smear layer *on the floor under the desktop icons* (icons are furniture, pushed
  icons slide over the smear). The desktop exposes `desk.getFloorLayer()` (an element between wallpaper
  and icons; desktop agent adds it) — put a WebGL canvas there. Accumulate paint thickness in a float
  render target with GPU-drawn stamps (tyre-tread pattern for wheels, smudgy brush band, round splats
  and droplets). Display shader: chocolate frosting (thin = translucent brown film over the wallpaper,
  thick = opaque glossy ganache), normals from the thickness gradient, specular from the scene's key
  light direction, a few crumbs. Must look like real food on a surface, not a paint brush.
- Robot: apply pitch/roll/lift; wheels, bumper underside and side brush pick up a brown tint with load.
- Sound (noise only, no tones): wet squelch on cakeHit/cakeClimb/cakeCrush, soft thud on cakeLand,
  sticky tyre noise loop ∝ load × wheel speed.
- Keys: K = new cake at the cursor; R also clears smear and resets the cake. Add a compact controls
  legend card stacked directly above the minimap card (same Liquid Glass style, small type, two columns):
  ↑↓←→ / WASD drive · Shift turbo · Enter autopilot · H home · E empty bin · C crumbs · K cake ·
  M map · R reset · Space pause · N sound. Toggle with L; hidden with ?nohud.

## Desktop (desktop agent)
- English UI: menu titles "Finder File Edit View Go Window Help", English labels everywhere, clock in
  en-US format like macOS shows it ("Wed Oct 7  1:12 AM"), English kind names.
- Menu bar status items: only a few standard ones (e.g. Wi-Fi, battery with %, Spotlight, Control
  Center, clock). Drop the third-party glyph strip lifted from the real menu bar.
- Dock: only popular apps (~10): Finder, Apps/Launchpad, Safari, Messages, Mail, Maps, Photos,
  Calendar, Notes, Music, App Store, System Settings (+ Trash); real icons from /System/Applications
  or /Applications via the existing Swift helper; a few running dots. No personal apps.
- Make every desktop icon draggable at all times: including Macintosh HD, icons the robot has pushed
  or rotated, icons currently in contact with the robot, during remote control, and in the narrow
  browser pane. Find out why some are not today and fix the cause.
- Add `desk.getFloorLayer()` (see Render). Keep the dev harness working.
