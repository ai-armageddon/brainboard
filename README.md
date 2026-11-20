# brainboard

A minimal, near-infinite whiteboard for thinking: paste images, write sticky notes and text, sketch with a pen, and build bubble flow charts.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Everything is stored locally in your browser (IndexedDB), and images are saved as blobs. To back up a board or move it to another machine, use **Export board…** in the top-left menu. Exports are plain `.json` files with the images embedded. To load one, use **Import board…** or drop the file onto the canvas.

## Using it

| | |
|---|---|
| **Pan** | Scroll or two-finger drag, hold `Space` and drag, or use `H` |
| **Zoom** | Pinch, or `⌘` + scroll · `⇧1` fit · `⌘0` 100% |
| **Images** | `⌘V` to paste, drag files in, or press `I` |
| **Write** | Double-click anywhere for text · `N` for a sticky note · `Enter` edits the selected item |
| **Draw** | `P` pen (pick color and size in the bar that appears) · `E` eraser |
| **Flow charts** | `O` bubble · `R` box · `D` decision · `C` connector |
| | Hover a shape and drag one of its dots to another shape to connect them. Drop on empty space to create a new connected bubble. Click a dot to add a bubble in that direction. |
| | `Tab` adds a connected bubble to the right (`⇧Tab` adds one below), even while you're typing |
| | Double-click a connector to label it |
| **Arrange** | `⌥`-drag or `⌘D` duplicates · `]` / `[` brings to front or sends to back · arrow keys nudge |
| **Undo** | `⌘Z` / `⇧⌘Z` |

Press `?` in the app for the full list.

## Code map

- `src/state.ts`: board state, undo history, and saving
- `src/render.ts`: DOM/SVG rendering of items, connectors, selection, and the camera
- `src/input.ts`: pointer, keyboard, clipboard, and drag-and-drop handling
- `src/actions.ts`: operations such as creating, editing, deleting, images, zoom, and import/export
- `src/ui.ts`: toolbar, context bar, menu, and theme
- `src/geometry.ts`: shape paths, connector curves, and stroke smoothing
