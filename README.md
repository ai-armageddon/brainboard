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

## Collaborate in real time

Click **Share** in the top right to make invite links. Each link either **can edit** or **can view**. You can change a link's permission or revoke it at any time, and that applies instantly to everyone using it. Guests pick a name and colour, then join only that board. They can't see your other boards.

- **Live presence:** everyone's cursor, selection and "typing…" marker, in their colour. Click an avatar to **follow** that person's view.
- **Present:** everyone follows your view while you walk through the board. They can choose "Look around", unless you lock the view.
- **Session controls** in the Share dialog: *Pause editing* makes everyone else view-only, *Lock view while presenting*, *Show viewers' cursors* (turn off for big audiences), and a **Remove** button for each person.
- **Reaching guests:** `npm run dev` and `npm start` listen only on this computer. For people on the same Wi-Fi, run `npm run share`; the Share dialog picks your network address for the links. For anyone else, run `npm start` and put it behind a tunnel (for example `cloudflared tunnel --url http://localhost:5317`), then paste the tunnel's address into **Link address**. The dev server rejects tunnel hostnames.
- **Security:** requests from this computer are the owner. Other devices need an invite link, or the private owner link printed by `npm run share`. Cross-site requests are refused, and roles are enforced on the server, not just in the UI.

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

Press `?` in the app for every shortcut. A short tour pops up the first time you open brainboard, and you can replay it from the menu with **Quick tour**.

## Vim keys

Some vim keys work all the time, because they don't clash with anything:

| | |
|---|---|
| `:` (or `;`) | Command line. `Tab` completes, `↑`/`↓` scroll history |
| `/` | Search the board's text as you type. `Enter` keeps the match |
| `u` · `⌃R` | Undo / redo |
| `w` `b` · `gg` `G` | Next / previous item, first / last item (reading order) |
| `a` | Edit the selected item, cursor at the end |
| `yy` · `x` | Yank / cut the selection |
| `zz` · `zi` `zo` | Centre the selection, zoom in / out |
| `ma` · `'a` · `''` | Mark this view as `a`, jump back to it, jump back to where you were before |
| `gt` · `gT` | Next / previous board |

Turn on **vim mode** with `:set vim` (or **Vim keys** in the menu). It adds the keys that normally pick a tool, so tools move to `:pen`, `:note`, `:bubble` and so on:

| | |
|---|---|
| `h` `j` `k` `l` | Hop to the nearest item in that direction |
| `H` `J` `K` `L` | Pan the view |
| `i` · `cc` | Edit text, cursor at the start / replacing it |
| `o` · `O` | New connected bubble below / above |
| `dd` · `p` `P` | Delete (and yank) / put after or before the selection |
| `n` · `N` | Next / previous search match |

Useful commands:
- `:e {board}` opens a board, with name completion. `:new`, `:file {name}`, `:bn` and `:bp` manage boards.
- `:%s/old/new/g` finds and replaces across the board; `:s/…` does the same for the selection. Patterns are JavaScript regular expressions; `&` and `\1` work in the replacement.
- `:color red`, `:shape decision`, `:zoom 150`, `:fit`, `:theme dark`, `:follow Sam`, `:present`, `:share`, `:export`, `:marks`, `:help`.
- `:w` and `:q` work too, but brainboard saves as you go.

## Code map

- `src/`: the app (vanilla TypeScript and Vite)
  - `state.ts`: board state and per-user undo · `net.ts`: server connection and live sync
  - `render.ts`, `input.ts`, `actions.ts`, `ui.ts`: canvas, input, operations, chrome
- `server/`
  - `store.ts`: board and image files · `api.ts`: HTTP API · `realtime.ts`: live rooms over WebSocket
  - `mcp.ts`: MCP server · `agent.ts`: outlines and auto-layout · `render.ts`: PNG rendering
  - `auth.ts`, `sharing.ts`: owner and guest access
