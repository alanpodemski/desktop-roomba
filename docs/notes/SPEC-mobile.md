> Design notes for the build agents (round 4: phones). Same conventions as SPEC.md / SPEC-mess.md / SPEC-plate.md.
> LOCAL ONLY: work happens on the local git branch `mobile`. Never push (any push to GitHub deploys to Vercel)
> and do not commit; the coordinator commits.

# Round 4: an iPhone home screen version for phones

The user, translated: "Make a mobile version, it looks very bad on phones now. Fewer icons, everything
smaller, but the same idea. Or maybe make it an Apple (iPhone) home screen!" So on phones the page becomes a
faithful iPhone home screen (current iOS, Liquid Glass design) where app icons are the furniture, with the
same robot, sim, cake-on-plate and smear, scaled down. The desktop version must keep working exactly as now.

## Mode selection (src/main.js)
- `?mobile=1` forces the phone layout (also on a desktop browser, for testing), `?mobile=0` forces desktop.
- Auto: phone layout when `matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 600`.
- On a desktop browser with `?mobile=1` and a wide window, centre a phone-sized stage (393×852 CSS px, rounded
  corners, dark surround) so it can be tried on a laptop; on a real phone the stage is the full viewport.

## Phone home screen module (phone agent): src/phone/
`createPhone(root, { stage })` with exactly the same API as createDesktop (getWalls, getIcons, getDock,
setIconPosition, onIconDragStart/onIconDrag/onIconDragEnd, onResize, setClock, getFloorLayer, getSize, data)
plus `getPxPerMeter()` (the physical scale for this layout, see below).
- Status bar: time at the top left in iOS style ("12:04", no AM/PM), Dynamic Island (black capsule, centred),
  signal bars, Wi-Fi and battery at the right. White glyphs. Wall: the strip from y=0 to the bottom of the
  status bar / island.
- Home grid: 4 columns, 4 rows of app icons with small white labels (iOS sizes: 60–62 pt icons, continuous
  corner squircle — macOS 26+ app icons already have that shape), standard iOS spacing and margins. Apps
  (stock only): Calendar, Photos, Camera (Photo Booth icon is fine if no Camera), Clock, Weather, Maps, Notes,
  Reminders, App Store, Books, Podcasts, TV, Wallet or Home, Settings (System Settings icon), FaceTime,
  Freeform. Leave two or three grid cells empty in the middle area so the robot has room (that is the "fewer
  icons" request). A Calendar icon shows today's date.
- Above the dock: the iOS "Search" pill. Dock: Liquid Glass rounded rectangle at the bottom with Phone,
  Safari, Messages, Music. Page dots are not needed. Home indicator bar at the very bottom.
  Walls: the search pill + dock + home indicator area.
- Icons: generate PNGs at 180 px with the existing Swift helper (scripts/.bin/icon-helper, `icon` mode on the
  .app bundles in /System/Applications and /Applications) into public/ios/icons/, plus a small generator
  script scripts/ios-icons.mjs; ship a tiny fallback for when assets are missing.
- Wallpaper: reuse public/mac/wallpaper.jpg, cover-cropped to portrait. Same Liquid Glass styling family as
  the desktop module.
- Interaction like iOS: long-press (~450 ms) on an icon enters jiggle mode (all icons wiggle, a "Done" pill
  top-right); in jiggle mode icons can be dragged anywhere (free placement, not snapped, since they are
  furniture now); tap Done or empty space to leave. Dragging sends the same callbacks as the desktop so the
  sim makes the dragged icon kinematic. Touch-action none, no page scroll / zoom / rubber-banding,
  safe-area insets respected, 100dvh.
- Icon masses: same physics idea: give each app a mass in the 20–320 g range from its real app bundle size
  (`du -sk`), log scale like massFromBytes.
- getDock(): the robot's charging station on the left edge around 55–60% of the height, facing into the
  screen (angle π, like the desktop), clear of icons.
- getPxPerMeter(): about 210 px/m on a 393 px wide phone (robot Ø ≈ 70 px, roughly an app icon), scaled
  with the stage width.

## Integration (integration agent): src/main.js and src/render/
- PX_PER_M must become a runtime value: createScene, robot, dock, cake, plate, dust, smear, minimap, overlay
  and the sim (`pxPerMeter` config) all use the layout's value. Desktop stays 440.
- Touch driving: touch-and-hold on empty wallpaper (not on an icon or HUD) spawns a floating Liquid Glass
  joystick under the thumb; dragging it drives the robot via sim.setManual (throttle/steer from the stick,
  pushing to the rim = turbo); releasing hands back after the usual idle time. A quick tap on empty space
  does nothing (so it doesn't fight jiggle mode).
- Phone HUD: compact. A small status pill under the status bar (mode, battery, bin), a mini Clean map card
  that is smaller and collapsible (tap to expand/collapse), and a row of round glass buttons for the key
  actions: Home (dock), Cake (new cake on a plate at the screen centre), Empty bin, Map, Reset, Sound. No
  keyboard legend on phones; a one-time hint "Hold anywhere to drive · Long-press an icon to move it" that
  fades after a few seconds. ?nohud hides everything.
- Sound unlocks on the first touch. Keep everything noise-only as before.
- Performance on phones: cap DPR at 2, shadow map 512, fewer dust particles if needed, keep the 60 fps cap.
- Verify with the browser pane's mobile viewport (resize_window preset "mobile", touch emulation) and with
  `?mobile=1` on a laptop-sized window; screenshot both; confirm the desktop layout is unchanged.
