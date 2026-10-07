> Design notes for the build agents (round 3). Same conventions as SPEC.md and SPEC-mess.md.

# Round 3: the cake goes on a plate, and everything is easy to push

## What the user asked for, in their words (translated)
- "Not all icons move; everything should be more sensitive to pushing." Done by the coordinator:
  `massFromBytes` now gives 20 g .. 0.32 kg (desktop and sim), so the robot shoves every icon without
  its bumper clicking. Do not undo that.
- "The cake should be very easy to push from every side, and put it on a light plate, because it can't be
  seen." The dark slice disappears on the dark wallpaper; a bright white plate fixes that.
- "When I drive onto it the robot gets hung up, but it shouldn't be that bad: it should drive over it and
  hop a little, not stand still."

## Plate model (Blender agent) -> public/models/plate.glb
A real white ceramic dessert plate: Ø 0.22 m, flat well Ø ~0.15 m, a gently raised rim 0.016 m high at
the edge, glossy glaze (clearcoat) with a faint cool tint, subtle rim highlight, a small foot ring
underneath. Bright: from straight above under the app's key light it must read clearly white against a
dark purple wallpaper. Node name `Plate`, origin at the centre on the floor, +Y up, metres, Draco,
< 300 kB. The slice stands in the well, on top of the plate surface at y ≈ 0.006 m. Preview from above
on a dark purple background, and 3/4 with cake.glb placed on it.

## Sim (sim agent)
- The plate is a dynamic Rapier disc, 0.45 kg, low desk friction (glazed ceramic foot on a desk:
  μs ≈ 0.25, μk ≈ 0.18), so the robot pushes it easily from any side at nearly full speed. It collides
  with icons, walls, other plates and the robot. Pushing should feel like a real light plate: it slides
  ahead of the bumper and spins a little when hit off-centre.
- The standing slice rides on the plate (cake–plate friction μ ≈ 0.6). It is no longer something the
  robot normally hits directly: the plate rim reaches the bumper first.
- Tipping now comes from the plate's motion, with the same tipping physics as before: the slice tips
  when the plate's acceleration (from a hard hit, or when the plate is stopped suddenly by an icon or
  wall) exceeds the tipping acceleration of the slice, a > g·(d/2)/h_cg for the edge it would rotate
  about, or when the robot reaches the slice itself (plate pinned and the robot rides up onto the rim).
  A gentle push should keep it standing. A fast ram, or slamming the plate into something, tips it. It
  can fall onto the plate or off it onto the desk, depending on where it is on the plate and the
  direction.
- Drive-over: the robot must roll over a lying slice (on the plate or on the desk) and over the plate
  rim with a small hop and a brief slow-down, typically under ~0.7 s, then carry on. No stall and no
  escape ladder from one pass. Keep the wheel/belly suspension model but retune: less traction loss on
  frosting, softer yield so the slice squashes quickly under the wheels, and a lower effective climb
  height. Several passes should still crush it fully. Pitch/lift should show a visible bump (a few
  degrees and up to ~1.5 cm) and settle.
- Smear: unchanged rules, but smear printed on the plate area moves with the plate is NOT required; the
  plate simply sits on top of the floor smear layer.
- K places a new cake on a new plate under the cursor. resetMess() puts the plate and cake back.
- State: `plates: [{ id, x, y, angle, cakeId|null }]` (px, rad). Cakes on a plate report the cake's
  world pose as before (`floorX/floorY`, `x/y`, angle) plus `onPlate: plateId|null`. Events: `plateHit
  {force}`, `plateBump` (robot riding over the rim), existing cake events.
- Keep all 38 checks passing (scenarios C and D may need new expectations; keep them testing the full
  story: plate pushed, slice tips from a hard hit or a pinned plate, robot drives over it with a hop
  and no stall, crush after several passes, smear spreads). Add checks: the plate pushed from four sides
  moves with no bumper bounce; a gentle push keeps the slice standing; a single drive-over of a lying
  slice slows the robot for < 1 s and never triggers escape or stuck.

## Render (integration agent)
- Render every plate from `state.plates` with plate.glb (soft contact shadow, the plate occludes the
  floor smear under it). The cake renders on the plate's surface height when `onPlate` is set.
- Plate sounds, noise only: a short ceramic knock on `plateHit` (high band-passed noise burst), a light
  scrape while the plate slides (band-passed noise ∝ plate speed), a soft clack on `plateBump`.
- Update the controls legend if any key changes, and the README controls table if needed.
