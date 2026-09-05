Real photographs for the game tiles.

Drop square images here (600 x 600 px works well) named after the game id:

    aviator.jpg          jetx.jpg           ligihero.jpg
    kings-move.jpg       ligiviator.jpg     aviatrix.jpg
    comet-crash.jpg      liginare.jpg       instant-virtuals.jpg

Then add that id to `photoTiles` in
frontend/src/app/features/dashboard/player-dashboard.component.ts, e.g.

    readonly photoTiles: string[] = ['jetx', 'ligihero'];

Tiles not listed keep the vector artwork, so nothing 404s.
