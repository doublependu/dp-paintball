

# Visual

 1. "Character paint" is not rendered reliably. After a hit is registered by the scoring system, I often don't see paint at all on myself or an NPC.
    - When the scene crosshair lands on a player, a paint ball is fired and it's not dodged, then the score should change and there needs to be a paint splash on that player.
    - Especially when hitting an NPC at close range, the paint sometime renders and sometimes not. 
 2. (done) Branches of trees look like they are upside down.
    - Two separate causes, both genuinely inverted. The `elm_trunk` mesh in
      `park-props.glb` attached each limb to the bole at a wide radius and
      converged it toward the axis as it rose, over a cone that flared toward
      the crown. And `CanopyAtlas` wrote its top-lit gradient as `1 - y/tile`
      against a `DataTexture`, whose `flipY` is false — so every canopy card in
      the park was lit from underneath.
    - Trunks are generated in code now (`src/world/TreeGeometry.ts`), in three
      species, with limbs that always rise as they travel outward.

# Gameplay

 1. There should be a limit on the number of paintballs available to each player. They can pick up new ones in game. 
 2. There should be a paintball gun model so that each player and NPC is actually holding a paintball gun
 3. The paintball gun should have a higher initial speed: right now, the game feels like players are throwing paints at each other. 
 4. (done) There should be two cross hairs
    - one is fixed to the view port, showing where the player is facing and the direction of the initial speed of the paint ball
    - the other is rendered on the scene, showing where the paint ball is actually going to hit in the 3D scene. 


# Map

 1. (done) I'd like to have a bigger map. I'll provide some ref images of Central Park New York for you to work with.
    - Play area 130x130m -> 184x184m; walkable ground 130x130m -> 336x336m.
    - Bigger, noise-edged Lake with an island; the Mall runs to z=88; the Ramble
      moved north of the water where it belongs; Sheep Meadow added as the one
      long sightline; a network of curving walks, because nothing in Olmsted's
      plan runs straight except the Mall.
 2. (done) Beyond the core play area of the map, there should be a procedurually generated forest beyond that. players can actually wonder into it if they choose to.
    - `PLAY_HALF`..`PARK_HALF` is a woodland belt scattered from a noise density
      field with glades and trails leading out of the park into it. Bots stay in
      the play area deliberately — the belt is somewhere for the player to go.
 3. (done) Beyond that, there should be city lines of New York city around the park.
    - `src/world/Cityscape.ts`: three ranks of instanced boxes per side over a
      ring street, with per-side profiles (midtown glass south, stepped pre-war
      masonry west, a limestone cornice line east, lower brick north).


# Misc


