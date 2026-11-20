# brainboard

A minimal, near-infinite whiteboard for thinking. Paste images, write sticky notes and text, sketch with a pen, and build bubble flow charts. You can also let AI agents read and edit your boards over MCP.

```sh
npm install
npm run dev      # http://localhost:5317  (app + API + live sync)
npm start        # production build, this computer only
npm run share    # production build, also reachable on your local network
```

Requires Node 22.18+ (the server runs its TypeScript directly).

Boards are saved as plain JSON files in `~/.brainboard/`, and images are stored next to them. Set `BRAINBOARD_DIR` to use a different folder. Every open tab stays in sync live. Deleted boards go to `~/.brainboard/trash/`.

## Use it with AI agents (MCP)

Brainboard ships an MCP server. It lets agents such as Claude Code, Claude Desktop or Cursor list, read, see and edit your boards. Their edits appear live in your open tab, and you can undo them.

**Claude Code** picks it up automatically inside this folder (`.mcp.json`). To use it from any folder:

```sh
claude mcp add brainboard --scope user -- node /absolute/path/to/brainboard/server/mcp.ts
```

**Claude Desktop / Cursor / other clients** use this config:

```json
{ "mcpServers": { "brainboard": { "command": "node", "args": ["/absolute/path/to/brainboard/server/mcp.ts"] } } }
```

| Tool | What it does |
|---|---|
| `list_boards` | All boards, most recent first |
| `read_board` | Outline of every note, shape, image and arrow, with ids, positions and the flow between them (or `format: "json"`) |
| `render_board` | A PNG of the board, including drawings and images (`show_ids` overlays ids) |
| `view_image` | Look at a pasted image |
| `add_items` | Add notes, text, bubbles, boxes, decisions and arrows in one call, with automatic layout |
| `update_items` / `delete_items` | Edit or remove items by id |
| `add_image` | Put an image on a board from a file path, URL or base64 |
| `create_board` / `rename_board` | Manage boards |

Try asking: *"Read my Launch plan board and add the next steps as a flow chart"* or *"Look at the screenshot I pasted on my board and summarise it in a sticky note next to it."*

## Using the canvas

| | |
|---|---|
| **Pan** | Scroll or two-finger drag, hold `Space` and drag, or use `H` |
| **Zoom** | Pinch, or `⌘` + scroll · `⇧1` fit · `⌘0` 100% |
| **Images** | `⌘V` to paste, drag files in, or press `I` |
| **Write** | Double-click anywhere for text · `N` for a sticky note · `Enter` edits the selected item |
| **Draw** | `P` pen · `E` eraser |
| **Flow charts** | `O` bubble · `R` box · `D` decision · `C` connector |
| | Drag a shape's dot to connect it. Drop on empty space to grow a new bubble. `Tab` adds a connected bubble to the right, even while typing. |
| **Boards** | Open the menu in the top left · `⌥N` new board · double-click the board name to rename it |
| **Undo** | `⌘Z` / `⇧⌘Z` only undo *your* changes, never anyone else's |

Press `?` in the app for every shortcut.

## Code map

- `src/`: the app (vanilla TypeScript and Vite)
  - `state.ts`: board state and per-user undo · `net.ts`: server connection and live sync
  - `render.ts`, `input.ts`, `actions.ts`, `ui.ts`: canvas, input, operations, chrome
- `server/`
  - `store.ts`: board and image files · `api.ts`: HTTP API · `realtime.ts`: live rooms over WebSocket
  - `mcp.ts`: MCP server · `agent.ts`: outlines and auto-layout · `render.ts`: PNG rendering
  - `auth.ts`, `sharing.ts`: owner and guest access
