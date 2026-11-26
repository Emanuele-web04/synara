# Synara Canvas

Canvas is a Beta-only design surface where coding agents create and revise static
HTML designs that the user edits beside the chat.
`DESIGN_CANVAS_BETA_FEATURE` (`packages/shared/src/betaFeatures.ts`) gates it: Stable
servers refuse every `canvas.*` RPC with `FEATURE_UNAVAILABLE`, offer agents no canvas
tools and add no canvas turn context; the Stable web app hides the rail entry, routes,
chat cards, header button and composer chip. Canvas state is stored per app data home,
so Beta data never reaches Stable.

## How the user meets it

| Surface       | Behavior                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat card     | One card per agent turn per work: thumbnail, frames created/updated, **Open** and **Restore previous version**. Built from a `canvas.turn` thread activity the gateway appends with a deterministic ID on the turn's first write.         |
| Side pane     | **Open** shows the work in the chat's right dock (`canvas` pane kind). Editable, with the tool strip; a slim inspector appears when the pane is at least 560 px wide. **Open full size** expands.                                         |
| Full layout   | `/canvas/$workId?page&chat`: the editor inside Synara's content card: the left panel (**Chat**, **Layers**, **Comments**), the tool strip, the canvas and the inspector. **Back to chat** (inspector top row) collapses to the side pane. |
| Header button | Opens the chat's latest linked work in the side pane, or the library when it has none.                                                                                                                                                    |
| Library       | `/canvas`: Recent, Files (folders) and Archive, grid or list, search, native previews of each work's cover frame, and a menu per work or folder. See "Library and pages" below.                                                           |
| Composer chip | The selection on the canvas shown beside a chat appears as a removable chip; its IDs reach the agent in the turn context.                                                                                                                 |

## Model

```
Execution host / Stable, Beta or isolated state home
├── Canvas library (design-canvases/library/<sha256(id)>.json; works version 3, folders version 2)
│   ├── Folders
│   └── Work: ID, title, optional project, archive state, asset metadata, chat links,
│             optional page-list dividers and cover frame
└── Asset store (design-canvases/assets/<sha256 of the bytes>), shared by every work
        └── Page: camera, frames, comment threads, optional icon
            └── Frame: ID, title, x/y/width/height, revision, frame style
                └── Layer forest: element (tag, attributes incl. inline style, child IDs)
                                  and text nodes, each with a stable ID; an inline SVG is
                                  an `svg` element whose shapes are element layers too,
                                  and a styled text range is a `span` element layer
```

Contracts: `packages/contracts/src/designCanvas.ts`, `canvasLibrary.ts`. A work lists
each asset's metadata and SHA-256; the bytes live in the content-addressed asset store and
load once per hash through `canvas.getAsset` (the server reads them with
`readAuthorizedFileBytes` and checks the hash). Version 2 works kept assets inline as base64:
they are still read, and the next change to such a work moves its bytes into the asset store
and writes version 3. Styles are
inline per element. Agents may still send `<style>` blocks or `css`:
`designCanvasInline.ts` resolves the cascade once on import with `css-select` over the
layer forest (specificity, source order, `!important`, inline precedence). Rules on
`html`, `body` and `:root` become the frame style. `@media` is evaluated against the
frame size. `:hover`, pseudo-elements, `@keyframes`, `@font-face`, `@import`, external
`url()` and unevaluable media are dropped and listed in the tool result's `dropped`.
`rem` becomes px using the root font size.

**Inline SVG** (`@synara/shared/designCanvasSvg`) uses the same element and text layers, so the
stored format is unchanged and version 3 works load as before: an `svg` element holds only
`g`, `defs`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`,
`linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`, `title` and `desc` (text
only inside the last two), with case-sensitive names (`viewBox`, `gradientUnits`) stored as
written. Each attribute has a value rule (lengths without `rem` or viewport units, path data,
number lists, transform lists, colours, keywords); paint and clip attributes may reference
`url(#id)` and a gradient's `href` `#id`, and nothing else. The importer reads `xlink:href` as
`href`, drops the standard `xmlns` declarations, `version`, `baseProfile` and `focusable`
without a report, and keeps no text outside `title` and `desc`. Every other part (an element
outside the list, an event handler, an external or non-fragment reference, a value that fails
its rule, `xml:` and other namespaced attributes, a DOCTYPE with entity declarations, an SVG of
more than 1,000 layers) follows the agent rule below: agent writes (`insert_html`,
`replace_html`, `synara_put_canvas_view`) leave it out and list it in `dropped`
(`Dropped onclick on <path> in an SVG: …`); editor writes refuse. `validateDesignLayers` checks
the same structure on every write (SVG elements only inside an `svg`, HTML never inside one, the
1,000-layer cap, which counts toward the frame's 3,000 layers, depth 64 and 192 KiB too), and
`set_attributes` on a shape checks the new value in both modes. IDs are stored as authored;
they only need to be unique inside their SVG (see Rendering and isolation).

**Rich text** (`@synara/shared/designCanvasText`) uses the same element and text layers too, so
the stored format is unchanged and version 3 works load as before. A styled range is a `span`
layer with no attribute but `style`, only text inside, and only typography in its style (the
span properties: `color`, `font` and its `font-*` longhands, `letter-spacing`, `line-height`,
`text-transform`, the `text-decoration*` and `text-underline-*` properties, `-webkit-text-stroke*`
and `paint-order`; no backgrounds, padding or layout). One predicate, `designTextBlockKind`,
decides what a text block is, for the editor, the agent reads, the renderer and the code export:
"plain" is an element that holds only text (today's text layer); "rich" is an element that holds
text and styled ranges, where a range is part of a text (the block also holds text of its own or
another range), and that is not a flex or grid container. A span holding all of a block's text (a
button's label) is a layer of its own, and so is any span with a class, a name,
layout styles or an element inside: such blocks keep today's behaviour. `<b>`, `<strong>`, `<em>`
and `<i>` are not ranges either (they stay separate layers). An editor commit writes the normal
form: empty runs dropped, neighbours with equal styles merged, a run without declarations unwrapped,
only range declarations on a span, spans never nested, and a range over all of the text moved onto
the block's own style. It is one edit batch (one undo step) of the operations every client already
replays: deletes in document order, `set_attributes` (a kept span's style) and `set_text` on what
stays, and `insert_layers` with editor-chosen IDs for new spans and text, so a span keeps its ID for
the first styled run that came from it and unrelated ranges keep their identity
(`designTextEditOperations`). No operation or contract was added. Every span goes through the same
validation and sanitizer as any layer (`insert_layers` refuses a style the sanitizer rejects;
agent `insert_html` drops and reports it) and counts toward the frame's layer and size limits.

`canvasLibraryStore.ts` is the single mutation owner (RPCs and MCP tools) with a
serialized queue, atomic writes and revision/mutation-ID receipts. A commit writes new
asset bytes to their files first, then the work document, so an edit never rewrites asset
bytes. Layer batches are atomic. `expectedRevision` is optional for editor and agent edits
alike: without it a batch merges onto the latest revision and fails only when a target layer
is gone; with it a stale revision refuses the batch. A retried `mutationId` returns the
stored receipt (created IDs, duplicate ID maps, dropped declarations) while it is still the
frame's latest edit. The two callers differ in two rules (`DesignLayerEditOptions.agent`):

| Rule                                 | Agent tools                                                                                       | Editor RPC (`canvas.editLayers`)                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| CSS value the sanitizer rejects      | Left out (the layer keeps its previous value), listed in `dropped`; the rest of the batch applies | Refuses the batch, so the preview reverts and the toast explains |
| Malformed CSS (bad name, two values) | Refuses the batch                                                                                 | Refuses the batch                                                |
| Refusal message                      | Names the operation: `operations[2] (set_styles on layer …) was refused: …`                       | The plain reason, as the editor's error toast shows it           |

Either way a rejected value is never stored: `dropped` names the property and the reason,
not the value. A style patch names plain properties, custom properties, or one of the few
vendor-prefixed longhands the inspector writes (`-webkit-text-stroke`, `-webkit-text-stroke-width`,
`-webkit-text-stroke-color`, `-webkit-line-clamp`, `-webkit-box-orient`,
`-webkit-backdrop-filter`); any other prefixed name is refused as invalid. A frame may carry `hidden` and `locked` (absent when off, so older readers
see nothing new); `canvas.layout` sets them per frame and takes an optional `order` of the
page's frames (the layers panel's frame reorder). Comment threads may carry `readAt` and
messages `editedAt`; `canvas.changeComments` adds `edit_message` and `delete_message` (the
caller's own messages only; the first message goes with its thread) and `mark_read`, which
leaves the thread's `updatedAt` alone. Removing a frame deletes its comment threads and export
rows; `canvas.restoreFrames` takes optional `comments` so the editor's undo can put them
back (threads whose frame is missing, or whose ID is taken, are skipped).
Page lists, icons and covers are additive version 3 fields, absent until used, so files
written before them load unchanged and older readers ignore them (an older server drops them
on its next write of that work). A work's `dividers` are separator lines in its page list:
each names the page it sits above (`beforePageId`, or null for after
the last page), so `pages` keeps the page order every older reader uses, and a divider is
never a page (no canvas, never in `pages`, refused by every page operation).
`@synara/shared/designCanvasPages` turns pages and dividers into one ordered list and back;
`canvas.changePages` uses it for `move` (a page or a divider before any item), `add_divider`
(before an item, null last), `delete_divider`, `set_icon` (one of `CANVAS_PAGE_ICONS`, null
for the default) and `set_color`. A page's `color` (set from the inspector's
Page section with nothing selected) is lowercase `#rrggbb` or `#rrggbbaa`; the canvas paints it
behind that page's frames, and absent (or set back with null) it shows the theme's canvas
colour. It is additive like the other page fields: older files load unchanged, older readers
ignore it, and Stable refuses `canvas.changePages` like every canvas RPC. A new page goes last, below a trailing divider; deleting a page leaves its
divider above the page that followed. A page's `icon` is stored as any short key, so an icon
only a newer client knows shows the default icon instead of making the work unreadable. At
most 32 dividers. A work's `cover` (`pageId`, `frameId`) is set or
cleared with `canvas.update` (refused on an archived work); the library preview uses it while
that frame exists and the first frame otherwise, so undoing the frame's delete brings it back.
A library summary lists, as `previewAssets`, the work's fonts and images that preview frame uses
(fonts by family, images by `synara-asset:` ID), so a thumbnail loads them without the whole work.
Deleting the cover's page drops the cover; duplicating a work maps its dividers and cover to
the copy's new page IDs. Both changes publish the usual `work` event.
`canvasTurnHistory.ts` keeps per-chat restore points: the first snapshot of each frame an
agent turn touched (bounded to 40 turns and 6 MiB per chat).

Every commit publishes a `changed` event on `canvas.subscribe`. It stays an invalidation
with an optional delta:

| Scope     | Fields                                                                                                                                                                                                                                                                                                                    | Client                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| none      | —                                                                                                                                                                                                                                                                                                                         | Refetches everything (new subscription, lost events, folder archive or move)     |
| `library` | —                                                                                                                                                                                                                                                                                                                         | Refreshes the list and folders only                                              |
| `work`    | `workId`, `updatedAt`, `previousUpdatedAt`; `pageId` when a page changed; for frame writes `frameId` and `revision`; for layer edits `mutationId` and a `delta` (the applied operations, with `set_styles` resolved to the style attribute and `insert_html` to the created layers, the frame style and the edit receipt) | Applies the delta, or refetches that one work; refreshes the list and turn cards |

The agent-only operations resolve to the same applied edits, so clients need nothing new:
`duplicate` arrives as `insert_layers` with the copy's new IDs (the ID map rides in the
receipt), and `replace_html` as `insert_layers` before the old layer followed by its `delete`.

Two ephemeral events share the stream. `activity` names what an agent is working on:
`frameIds`, an optional `kind` (`read`, `write`, `edit` or `delete`; absent means a write, as
older servers sent it), optional `layerIds` per frame (up to 200; a frame left out means the
whole frame), and `expiresAt` 40 s later. When the agent's turn ends (`thread.session-set`
settling the turn, watched in `main.ts`), the store publishes one `ended: true` event per
page the thread still had activity on, and clients drop that thread's activity there.
`render` asks an open window for a screenshot (optionally cropped to `layerId`, at `scale`
1 or 2) or, with `measure`, for layer boxes and optionally computed styles; the window
answers through `canvas.submitRender` with a PNG, an error, or `layers`.

A client applies a delta only when it holds exactly the previous state (same
`previousUpdatedAt`, frame at `revision - 1`), with `applyDesignLayerEdits`
(`@synara/shared/designCanvasLayers`); otherwise it refetches that work. Deltas over 64 KiB
are left out. `updatedAt` never goes backwards, so the cache never takes an older copy. The
web app subscribes once (`CanvasEventBridge`, `canvasWorkCache.ts`); events for a work wait
while that client's own write to it is in flight, so its echo is recognised instead of
refetched. A subscriber that falls 256 events behind is restarted and refetches.

Limits: 32 pages, 48 frames per page, 3,000 layers and 192 KiB of inline-styled HTML
per frame (inline SVG included; at most 1,000 layers in one SVG), 200 comment threads per page, 192 assets (2 MiB each) and 8 MiB per work
(document plus asset bytes). Frames are 16–4096 × 16–16384 px; zoom is 5–800%.

## Library and pages

The library (`CanvasLibraryView.tsx`, `/canvas`):

- **Sections:** Recent (every work that is not archived, from every folder, latest change
  first), Files (one folder at a time: its folders, then its
  works, with a trail back up) and Archive (archived works and folders; a work inside an
  archived folder offers "Restore the parent folder first").
- **Search** matches titles; in Files it searches every folder. **Grid or list**, remembered
  per viewer: cards with the thumbnail, or rows with a small one. Thumbnails render the work's
  cover frame through the sanitized renderer, with the fonts and images it uses
  (`previewAssets`).
- **Menu** on a work or folder: Open, Rename (the shared rename dialog), Duplicate (works; a
  "(copy)" suffix, the copy stays in the library), Move to (Files or a folder; a folder never
  into itself or its subfolders), Associated project (works), Archive or Restore.
  There is no permanent delete.
- **Empty states:** no works yet, an empty folder, an empty archive, no search matches.
- Pages, dividers, icons and the cover frame: see Model and the editor's Pages list below.
- The library has no sharing, links or teams: works live in this app data home.

## Rendering and isolation

Frames render natively in open shadow roots (`apps/web/src/lib/designCanvas.ts`), built
node by node from the layer model with no HTML parsing, so a design can never become
markup or script. The renderer keeps a map from layer ID to DOM node and patches it: an
unchanged layer keeps its element (and any drag or scrub preview on it), a changed one is
rewritten in place through the same sanitizing writer, and nodes are created, moved or
removed by ID. The layer being typed into is left alone until the edit ends, so remote
changes elsewhere in that frame still show. Exports build through the same renderer. The
host keeps the boundary:

| Risk                       | Control                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script                     | Only allowlisted tags/attributes are created; no `script`, `iframe`, event handlers or `href`. Controls are `disabled`.                                                                                                                                                                                                                             |
| Network                    | Every `url()` except owned assets and inline images is dropped (server and renderer); `image-set()`, `attr()`, `element()` etc. are refused. Images use blob URLs of work assets.                                                                                                                                                                   |
| Painting outside the frame | The host is `contain: strict` with `overflow: clip`; `position: fixed` resolves inside the frame.                                                                                                                                                                                                                                                   |
| Host styles and variables  | `all: initial` on the host; design custom properties are renamed (`--x` → `--sc-x`), so `var(--background)` never reads Synara's theme.                                                                                                                                                                                                             |
| Viewport units             | `vh`/`vw` become container units of the frame (`container-type: size`).                                                                                                                                                                                                                                                                             |
| Input                      | `pointer-events`, `cursor`, `user-select`, `app-region` (an Electron window-drag handle) and similar are dropped; the editor owns every pointer event.                                                                                                                                                                                              |
| Fonts                      | Work fonts register through `FontFace` under `SynaraCanvas <family>`, so a design's "Inter" cannot replace Synara's own font.                                                                                                                                                                                                                       |
| Inline SVG                 | Built with `createElementNS` from the SVG subset only, inside an `svg` layer; the renderer rechecks every element and attribute value, so a refused construct never reaches the DOM. No `script`, `foreignObject`, `style`, `use`, `image`, `a`, animation, filters or event handlers.                                                              |
| SVG references             | Only `url(#id)` and a gradient's `href="#id"`; every `id` and reference renders as `sc.<svg layer ID>.<id>`, unique to that SVG in its frame (layer IDs never hold a dot), so one SVG cannot reach or shadow another's definitions; an HTML `id` starting `sc.` is not rendered, and frames are separate shadow roots. CSS `url(#…)` stays refused. |
| SVG units and entities     | Attribute lengths take no `rem` or viewport units and no `var()`; the HTML parser expands no custom entities, and a DOCTYPE that declares some is refused.                                                                                                                                                                                          |

Export (PNG, multi-page raster PDF, JSON) and agent screenshots use the same builder
inside an SVG `foreignObject` image, which has no script or network access; an inline SVG
nests inside it unchanged, with its scoped IDs.

A rich text block is one text layer the same way: its spans render without a layer ID (only the
block carries one), the editor indexes the block with its text alone (`indexLayers`), so a click,
Cmd-click, marquee, drill, Enter or Tab never lands on a span, and the layers panel shows one row
labelled with all of its text. Agents still address its spans and their text by layer ID.

An inline SVG is one leaf layer in the editor (it is selected as a unit): only the
`svg` element carries a layer ID in the DOM, and the editor's layer index lists it without
children, so a click, Cmd-click, double-click, marquee, Enter or Tab lands on the SVG, never on
a shape inside it. It moves, resizes (`width`/`height` on the `svg`), hides, locks, copies and
duplicates like any element; pastes and drops go beside it, never inside. Agents still address
its shapes by layer ID.

## Layout and chrome

The editor is built from the app's own components and tokens, at their densest sizes, so it
reads as the rest of Synara.

| Part          | Synara                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell         | `CanvasWorkView.tsx`: the route header (back, title, page switcher) over the editor, in the same rounded, inset content card as every route. The editor body takes the card's corners (`--app-rail-block-radii`); its columns meet at `border-border` lines.                                                                                                                                      |
| Left panel    | `CanvasSidePanel.tsx`: the app's surface tab strip (`SurfaceTabStrip`, text-only `SurfaceTabChip`s as `role="tab"`) for Chat, Layers and Comments, 240 px for Layers and Comments and 360 px for the chat by default, each width resizable from the panel's edge (drag, arrow keys; double-click resets) and kept per tab. A width change moves the camera the other way, so the frames stay put. |
| Pages, layers | `ui/TreeRow.tsx` rows in the app's file-row tones (`fileRowToneClassName`): 28 px, the chevron in the indent, a 16 px icon lane, long names truncated. The Pages header collapses the list; the open page has a check. A splitter under the pages list sets its height (drag or arrow keys; double-click fits the pages), kept per viewer; the layer tree follows without a header.               |
| Tool strip    | `CanvasToolStrip` (`editor/CanvasToolbar.tsx`): the app's ghost `icon-sm` toggles and buttons in a 40 px column, tooltips on the right with the shortcut in the app's key cap; undo and redo at its foot.                                                                                                                                                                                         |
| Inspector     | 280 px (232 px slim in the side pane). A top row with what is selected (side pane only), Read only, the zoom menu and, in the full layout, **Back to chat** and the work's menu. Sections have 32 px headers over 24 px rows: the app's `xs` inputs and selects, `icon-xs` buttons, the `sm` `SegmentedPicker`, the app checkbox; dimmed until set.                                               |
| Popups        | The app's menus (`ComposerPickerMenuPopup`), selects, combobox (font picker), popovers (colour picker, formatting, export settings) and the default tooltip. The comment card uses the app's popover surface, placed with the camera's CSS variables so it follows a pan without a render.                                                                                                        |
| Library       | Cards and rows on the app's card surface and border (`bg-card`, `border-border`), 256 px cards 24 px apart, the section tabs as a `SegmentedPicker`, grid or list as a `ButtonGroup`; the Move to menu lists folders as their tree.                                                                                                                                                               |
| Comment pins  | Keep their 26 px screen size down to 50% zoom, then shrink with the canvas to half size at 25% (`--canvas-pin-scale`), from their anchor corner.                                                                                                                                                                                                                                                  |

**Tokens.** The canvas backdrop (`--canvas-backdrop`) is the app's `--background` with the muted
tint (4% of `--foreground`), so white frames keep their edges on it; a page's colour replaces it.
The other `--canvas-*` variables in `apps/web/src/index.css` have no app equivalent either: the
on-canvas accent for selection outlines, handles and badges (`--canvas-accent`, the app's
`--info`) and its lighter hover tint (`--canvas-hover`), the agent's colour (`--canvas-agent`,
the app's `--claude`), and the dark chips, measure lines and drop bar that sit on the user's
own frame content and so keep one colour in both themes. Text follows Settings through the
`text-ui*` tokens; radii follow the app's `--radius` scale.

Shared components gained only additive options, so every other surface renders as before:
`Input` and `inputControlClassName` a `size="xs"` (24 px), `SelectTrigger` a `size="chip"` (a
20 px select inside another field, the W/H sizing mode), `SegmentedPicker` a `size="sm"`, an
`iconOnly` mode with tooltips, a `null` value for mixed selections and a per-option `tooltip`,
and `SurfaceTabChip` a `selectionAria="tab"` with tab and panel IDs, a `tooltip` (below the chip)
and `icon={null}` for a text-only chip; `fileRowStyles.ts` exports its focus tone for `TreeRow`.

**Shortcuts against the app's:** the app's global shortcuts listen on the window, before any
surface. While the canvas has focus it claims the keys it handles (`claimShortcuts` in
`keybindings.ts`): a live text edit's ⌘B / ⌘I / ⌘U / ⌘⇧X and undo, otherwise every key its
own shortcut map matches (⌘D, ⌘\, ⌘[ …). A claimed press resolves no binding and no fixed
shortcut, so it reaches the canvas, which also stops the desktop menu's accelerator. Outside
the canvas nothing changes (`editor/CanvasAppShortcuts.browser.tsx`). The app's shortcuts
sheet (⌘/) has a Canvas section built from the same rules (`CANVAS_SHORTCUT_GUIDE` in
`canvasShortcuts.ts`, Beta only), and a test replays every listed press through the rules, so
the sheet and the tooltips cannot drift from what the keys do.

**Form controls in frames** stay inert (no focus, input, activation or submission) but look
enabled unless the design disabled them, and every control takes the frame's font. Text fields,
selects and buttons are disabled and marked `data-synara-inert`, which the frame stylesheet
draws with the browser's enabled colours; options are not disabled, so a select shows its value.
Checkboxes, radios, sliders and colour wells, which the browser paints itself, stay enabled and
out of the tab order, and the frame root cancels a press, click or key on them and drops any
focus they get. A control the design disabled keeps the disabled look. Frames have no shadow or
outline of their own on the canvas. Chat turn-card thumbnails, library thumbnails and the
composer's selection chip load the work's fonts and images (`useCanvasPreviewContext`), so they
draw as the frames do.

## Editor

Code (`apps/web/src/components/canvas/editor/`): `CanvasViewport.tsx` composes the canvas;
`useCanvasGestures.ts` (pointer gestures, state in refs: hit test, click, double-click, drag,
resize, flex spacing handles, marquee, drawing, comment placing) with `canvasGestures.ts`
(resize, drag, axis lock, reparenting and drop geometry) and `canvasGestureLayer.ts`
(marquee, drop bar, reparent target, drawing and value chips, drawn outside React);
`canvasLiveGeometry.ts` (where a gesture has put things, for the inspector);
`CanvasOverlay.tsx` (selection chrome in world pixels); `CanvasAgentActivity.tsx` (agent
outlines, rain, reveal flashes, the pages-list indicator); `canvasSelection.ts` (hit stack,
click and marquee rules, locks, tree helpers); `canvasMeasure.ts` (boxes, camera conversions,
drawn boxes, the size badge, blocked frame labels); `useCanvasCamera.ts` (zoom, fit and centre
for every control, animated; wheel and pinch; first-open placement); `useCanvasTextEditing.ts`;
`canvasShortcuts.ts` (the key map, in precedence order, and its guide); `canvasCommands.ts`
(every command, built once per editor); `canvasClipboard.ts`; `canvasContextMenu.ts`;
`canvasToasts.ts`; `CanvasLayersPanel.tsx` with `canvasLayerDrop.ts` (drop zones and depth);
`CanvasComments.tsx`, `CanvasCommentsPanel.tsx`, `CommentPin.tsx`. The Layout section's
selection actions (align, distribute, resize to fit or fill, resize by a step) live in
`inspector/layoutActions.ts`, shared by its buttons and the keys.

- **Camera:** each client keeps its own camera per work and page in local storage
  (`editor/canvasCamera.ts`); panning and zooming never write the work. A page this client
  has not opened before uses the page's saved camera if it has one, otherwise it fits the
  page's frames, or centres the origin at 100% when the page is empty and fits its first
  frames when they arrive. Agents can still set a page's camera; it is only that default.
  While a pan or wheel zoom runs, the camera is written straight to the world transform and
  to CSS variables the selection chrome and comment pins are placed with; it is committed
  when the pan ends or the wheel has been still for 150 ms. Zoom steps, 100%, fit, the zoom
  menu, N/⇧N, centring a layer from the layers panel and revealing a comment animate for
  200 ms through the live camera (no render per frame; reduced motion jumps; a pan or wheel
  during it stops it). A pinch (ctrl+wheel without Ctrl held) zooms 0.01 per pixel of
  delta, a held Ctrl/⌘ with a mouse wheel 0.002, so a wheel notch is a step. A pan ends where
  it got to when the window loses focus. Zoom stays 5–800%.
- **Tools:** V move, H hand (Space held), F/A frame, R rectangle, T text, C/Y comment,
  image insert/drop/paste. Shapes and text drawn inside a frame become absolutely
  positioned layers; drawn on empty canvas they create a frame. While drawing, Shift keeps a
  square, Alt draws from the centre (both combine) and holding Space moves the box's origin
  with the pointer; a plain click makes a 100 × 100 box centred on the click. The tools sit in
  the vertical tool strip at the canvas's left edge, with undo and redo at its foot.
- **Hit test and click:** every layer within 4 screen pixels of the pointer is hit, ancestors
  first and the deepest last; the tolerance reaches only inside the topmost layer under the
  pointer, so a 1 px line is easy to hit but a neighbouring button never wins over the one
  under the pointer. A click picks the frame's top-level layer (full-bleed wrapper `div`s are
  skipped); with a nested selection it picks the layer at the selection's depth, so siblings
  and cousins are one click away; a click inside a selected layer keeps it; Cmd/Ctrl picks the
  deepest. A frame that has layers is not selected by a click on its body (the click starts a
  marquee): its label, Cmd/Ctrl, or being selected already does; an empty frame selects
  normally. Locked layers (and layers under a locked one or in a locked frame) cannot be
  selected, moved, resized or edited from the canvas, the layers panel or the walking keys. A
  press becomes a drag after 5 px. A second press within 500 ms and 5 px is a double-click: on
  a frame label it renames inline, on editable text (however deep) it starts editing,
  otherwise it drills one level toward the pointer; Shift keeps the rest of the selection.
  Esc selects the parent (⇧Esc or Ctrl+Esc deselects), Enter selects children or edits text,
  Tab cycles siblings, Shift adds or removes.
- **Marquee:** from empty canvas or a frame's body, anywhere with Cmd/Ctrl; it selects after
  5 px. Without Cmd, once it holds a whole frame it selects only the frames it touches;
  otherwise it selects frames it covers and, in frames it only partly covers, the top-level
  layers it touches. With Cmd it recurses into every container it does not fully contain and
  picks the deepest layers it touches (a container whose children it misses is picked
  itself). Boxes are what is visible after clipping; hidden and locked layers are skipped with
  their subtrees. Shift toggles the result against the selection held before the marquee;
  holding Space moves the marquee. The net change is one undo step.
- **Selection chrome:** selection outlines, handles and the badge in the canvas accent
  (`--canvas-accent`); the hovered layer gets a 2 px outline in the hover tint
  (`--canvas-hover`). Four white 7×7 corner handles with a 1 px outline; edges are invisible
  hit zones (kept off layers under 24 px on screen). Double-clicking a handle fits the layer to
  its content on that handle's axes (a corner both, an edge one); with Alt it fills the parent.
  A rotated layer's outline and handles turn with it and its handles resize along its own axes.
  A W × H badge sits under the selection and names a size's mode when it is not fixed
  ("Fit 320 × Fill 48"); several items keep their outlines and get a bounds box with the badge
  (no group resize). A layer inside a flex container shows its parent with a dashed outline, and
  while a selected flex container's child is hovered (⌘ on the canvas, or its row in the layers
  panel) its siblings get dashed outlines too. A
  selected flex container shows round padding handles in each padding band and gap handles
  between laid-out children; dragging one previews the padding or gap and saves it once.
  Holding ⌥ measures to the hovered layer.
- **Frame labels:** the title over the frame's top-left corner at screen size, muted, full ink
  on hover, in the accent while selected; the frame's size at the right while it is not
  selected; the work's cover frame leads with a cover marker. A label that would cover another
  frame (a neighbour close above it or reaching into its label row at the current zoom) stays
  hidden until its frame is selected.
- **Drag:** a drag follows the pointer in world coordinates, so a wheel pan or zoom during it
  keeps the layer under the pointer. Shift keeps it to the axis it moved further along. ⌥ on
  release duplicates: the originals go back and copies land where the drag ended (the
  original is what follows the pointer while dragging). A single absolutely positioned layer
  dropped over another container moves into it, at the position it was dropped (a "↳ Card"
  chip and the container's outline show the target); flow layers reorder in their layout with
  a drop bar; a layer selected with its frame moves with the frame only. Selection changes
  are undo steps: undo restores the selection before an edit, and a command's own selection
  change joins its step. Arrow keys nudge freely placed layers (Shift ×8) and reorder flow
  layers; ⌘ arrows resize the selection's width or height by 1 px (Shift 8); locked items stay
  put. 8 resize handles (4 drawn); Shift keeps the aspect ratio, Alt resizes from the centre,
  only the dragged axis changes.
- **Text editing:** `plaintext-only` editing of a text block (plain or rich) starts on
  double-click (deep text included), Enter on a text layer, T with one text layer selected, or
  the Text tool clicked on existing text, which places the caret at the click
  (`caretPositionFromPoint`). Enter, Esc, ⌘Enter, a blur or a click away saves once;
  Shift+Enter is a newline. Tab and ⇧Tab save and move to the next or previous editable text
  layer of the page in tree order. A layer left empty is deleted in the same step. Text the
  Text tool creates and the typing in it are one undo step; left empty, it is removed (with the
  frame it created) and leaves no step. Saved text with line breaks gets `white-space:
pre-wrap` when the layer would collapse them. An IME composing text keeps every key, Enter
  included.
- **Rich text** (`editor/canvasTextEdit.ts`, `canvasRichText.ts`): the browser never formats
  text. ⌘B, ⌘I, ⌘U and ⌘⇧X style the selected characters with the editor's own spans, written
  through the canvas sanitizer; with only a caret they style the whole block. A toggle switches
  on when any selected character lacks the format and off when all have it (bold is weight 600
  or more). Off on a range goes back to the block's value, so a span that only repeated it
  unwraps; underline or strikethrough drawn by the block is moved onto the ranges first, so
  part of it can be taken off, and the two lines combine. Typing inside a range keeps its
  style. The commit reads back only text and the editor's spans (markup the browser adds counts
  as text and line breaks) and saves typing and styling as one step, through the normal form
  above; a block with no range before or after saves exactly as plain text did. Paste inserts
  the clipboard's plain text at the selection, inside the range it lands in (line breaks as
  `br` where the block collapses them); foreign markup never reaches the layer. Once the editor
  has rewritten the element, ⌘Z / ⌘⇧Z inside the edit undo and redo its own steps (typing in
  bursts, each styling, each paste); before that the browser's own undo runs. Focus moving to
  the inspector keeps the edit open, its selection shown with a CSS highlight; a press anywhere
  else ends it. With nothing typed or styled, nothing is saved. Selected text layers that are
  not being edited take ⌘B / ⌘I / ⌘U / ⌘⇧X on the whole block, their ranges' own value
  cleared, as one step.
- **Shortcuts:** ⌘Z/⌘⇧Z/⌘Y, ⌘C/⌘X/⌘V, ⌘⇧V paste on top, ⌘⇧R paste to replace, ⌘D,
  ⌘R rename (frame label or layers panel row), ⌫ delete, ⌘⌫ or ⌘⇧G ungroup, ⌘⌥G wrap, ⇧F frame
  the selection (a plain frame around it), ⇧A add flex / wrap in flex, ⌥⇧A remove flex, ⌥C
  clip content, ⌘⌥C/⌘⌥V copy and paste styles, ⌘⇧H hide, ⌘⇧L lock, ⌘⌥⇧L unlock all, ] / [
  or ⌘⌥] / ⌘⌥[ front / back, ⌘] / ⌘[ or ⌘⌥↑ / ⌘⌥↓ one step, ⌘A siblings (else all frames), ⌘⇧A
  the others, ⇧Enter or \ parent, `+`/`=`/⌘= and `-`/⌘- zoom, ⇧0/⌘0 100%, ⇧1 fit all, ⇧2 fit
  selection, PageUp/PageDown pages, N/⇧N next/previous frame, ⌘⇧D library, `.` or ⌘\ hide the
  panels and tools, ⌥1 Layers, ⌥L collapse every layer, ⇧C hide comments, ⌘⇧E export, ⇧⌘C copy
  PNG, ⌥T/⌥R copy code. Several items: ⌥A / ⌥D / ⌥W / ⌥S align left, right, top and bottom,
  ⌥H / ⌥V horizontal and vertical centres; three or more: ⌃⌥H / ⌃⌥V distribute (macOS, where
  Ctrl is not the command key). Layers: ⌘⌥⇧R hug the content, ⌘⌥⇧F fill the parent; ⌘ arrows
  resize. Digits: with a selection they set opacity (1 is 10% … 0 is 100%, two digits within
  600 ms an exact value); without one 0, 1 and 2 zoom like ⇧0/⇧1/⇧2. Text keys on text layers
  (and every text layer in a selected frame): ⌘⌥L/T/R/J align; ⌘⇧. / ⌘⇧, size ±1 px, ⌘⌥. /
  ⌘⌥, weight ±100, ⌥⇧. / ⌥⇧, line height ±1 px, ⌥. / ⌥, letter spacing ±0.5 px; ⌘B / ⌘I /
  ⌘U / ⌘⇧X bold, italic, underline and strikethrough (see Rich text). Keys typed in fields,
  dialogs, menus and the canvas's own controls never reach canvas shortcuts. Tooltips on the
  tool strip, the Layers tab, the layer rows' eye and lock and the inspector's align, resize,
  flex and text-alignment buttons show the key.
- **Toasts:** actions with no visible result on the canvas confirm with the app's toast:
  styles copied and pasted, opacity set by a digit, every layer unlocked, comments hidden or
  shown. A new one replaces the last.
- **Clipboard:** a copy writes the layers' HTML source as plain text and, as `text/html`, a
  charset meta tag, the copied frames or layer trees as base64 JSON in a
  `<!--synara-canvas:v1:…-->` comment, then the HTML, so a paste after a reload or in another
  window recreates them; a browser that drops the HTML flavour still pastes this window's last
  copy. A paste tries, in order: image files, the embedded tree, plain text that is HTML source
  (starts with a tag, comment or doctype, ends with `>`, has a closing or self-closing tag),
  else text. An SVG document (an optional XML prolog, comments and DOCTYPE, then one `<svg>`),
  tried after the embedded tree, is inserted as an SVG layer through the same sanitizing
  `insert_html`; a part outside the subset refuses the paste with the reason. The embedded tree
  is untrusted: it must decode as canvas frames or layer trees, and reaches the server only
  through `insert_html` and `set_frame_styles` (a pasted frame's shell is restored empty, then
  filled), the same sanitizing path as any insert. Pastes go inside the selected container
  (beside a selected text layer), with ⌘⇧V on top of the selection (and at its position when
  both are free) or with ⌘⇧R in its place; pasted frames land 40 px further each time, or on
  the selected frame with ⌘⇧V/⌘⇧R; with nothing selected a new frame holds the paste. Each
  paste is one undo step. Assets do not travel between works.
- **Commands:** the right-click menu on the canvas and in the layers panel: Select layer…
  (canvas: every unlocked layer under the pointer, deepest first), Rename, Copy, Paste (with
  Paste on top and Paste to replace in its submenu), Duplicate, Copy as, styles, select
  parent/children, arrange, Adjust text (text layers: bold, italic, underline, strikethrough
  and the four alignments, through the same commands as their keys), wrap, ungroup, Add flex or
  Remove flex, hide, lock, export, Use as cover, Deselect, delete. A right-click on empty canvas
  offers Paste, Go to frame (Next and Previous frame) and Show or Hide UI. Variants of one
  action share a submenu row. Several layers sent to the front or back keep their order. Every
  gesture or command is one undo step, and undo restores only the style properties the user
  changed.
- **Layers panel:** paint order (front first), 28 px rows indented 16 px a level. Click
  selects, Shift a range, ⌘ toggles; locked rows cannot be selected. Double-click or ⌘R renames
  inline (layers as `data-name`, frames by title); Tab and ⇧Tab save the name and rename the
  next or previous row. Double-clicking a row's icon centres the camera on it. A chevron opens
  or closes a row; Alt-click opens or closes its whole subtree. Rows drag to reorder or nest:
  the top or bottom 24% drops beside a row, the middle inside it only while the pointer moves
  slowly (under 0.3 px/ms), and moving sideways in 15 px steps picks the depth among the
  parents that are valid there; the tree scrolls within 20 px of its edges. Dragging a
  selected row moves the whole selection, also into another frame (inserted there with its IDs
  unless taken, then deleted from the source, one undo step). Frame rows rename, reorder, hide
  and lock (`hidden`/`locked` on the frame, `order` in `canvas.layout`; hidden frames are off
  the canvas, locked ones out of reach). Eye and lock buttons show on hover and stay while on;
  a lock inherited from a parent shows a dot; hidden layers and everything under them are
  dimmed. ⌥L collapses every row, and so does **Collapse all** from a right-click on the
  panel's empty area; ⌥1 shows the Layers tab. Hovering a row outlines the layer. An inline SVG
  is one row (vector icon, no expander); nothing drops inside it.
- **Inspector** (`apps/web/src/components/canvas/inspector/`): sections in a fixed order, each
  shown only when a selected node can take it and dimmed until set (clicking the dimmed header
  adds a default): Layout, Radius, Blending, Fill, Text, Underline, Outline, Text stroke,
  Border, Shadow, Inner shadow, Filters, Other styles, Selection colors, Export. An inline SVG
  shows the box sections (Layout without Flex, Radius, Blending, Fill, Outline, Border,
  shadows, Filters, Export) and, when it paints with `currentColor`, an SVG section after Fill
  whose Color writes `color` on the `svg`; that colour is also in Selection colors. Text
  sections never show for it. Computed values are shown, inline styles are written through the
  editor's style edits; a change to several layers is one undo step even when each needs its
  own patch, and scrubs, drags and pickers preview on the DOM before one save. Number fields
  scrub by their label, nudge by 1 (Shift 8, Alt 0.1) and take arithmetic (`24*2`,
  `(100-8)/2`, one unit at most). A value that differs across the selection shows `–`; a list
  that differs (fills, borders, outlines, shadows, inner shadows, layer and backdrop filters,
  underlines, export rows) shows one row that gives every node the first node's list.
  - Layout: frame X/Y/W/H; layer X, Y and rotation (`rotate`; a transform that is only
    `rotate()` moves there) with a rotate-90° button (⌥ the other way), W/H with
    Fixed/Fit/Fill/Relative, and for absolute layers the constraints (left, right, left and
    right, centre; top, bottom, both, centre), written as the inset the layer keeps (`right`,
    `calc(50% ± Npx)`) so X/Y edits keep the pin. The header holds hug content / fill parent,
    or for several frames or absolute layers six align buttons and Distribute (equal gaps
    between the first and last). Flex: Add flex, or Wrap in flex for several layers (the ⇧A
    command); with flex, a Flex row with direction, Wrap, a menu (space between per axis,
    first or last baseline) and Remove flex, the 3×3 grid with its space-between and baseline
    variants, the gap and, when wrapping, the line gap, then padding. Absolute position and
    Clip content close the section.
  - Fill is a stack, top first, reordered by dragging: solid, gradient (linear, radial,
    conic; angle; OKLab, OKLCH or sRGB interpolation; stops with positions, add, spread
    evenly) and image fills (a work asset; cover, contain or tile), each with a type menu and,
    above the bottom fill, a blend mode. The bottom solid is `background-color`, the rest
    `background-image` layers with matching `background-blend-mode`, `-size`, `-position`
    and `-repeat` lists; a frame with no fill is written transparent. Gradients the inspector
    cannot write back (repeating ones, colour hints, px stops) stay as a read-only row.
  - Text: family (with Favorites, kept per viewer), style (weights, plus italics when the
    family has them), size, line height, letter spacing, horizontal and vertical alignment
    (vertical uses `align-items`/`justify-content` in a flex box and `align-content`
    elsewhere), colour, and Formatting: alignment with justify, case, wrap (`text-wrap`: none,
    normal, pretty, balance), keep words (`word-break: keep-all`) and truncation with max
    lines (a `-webkit-line-clamp`). Underline: colour, thickness and offset (px or %, Auto),
    shape, line (under, over, through), skip ink, and reset colour. Text stroke:
    `-webkit-text-stroke` colour and width, and over or under the fill (`paint-order`). While a
    text block is being typed into, Text (font, style and weight, size, line height, letter
    spacing, colour, case), Underline and Text stroke read and style the selected range, or the
    whole block with only a caret; the other Text controls (alignment, wrap, truncation) always
    write the block. A selection over differently styled ranges shows the mixed value. The
    change shows at once and is saved with the edit, as one step. The range is read through
    `canvasTextSession.ts`, an external store, so a caret move renders only those sections,
    never the canvas. Other sections keep writing the block straight away and show on it while
    it is being typed into.
  - Outline (layers that are not text-only): style, colour, width, offset. Shadow: box shadows,
    or drop-shadow filters from the section menu, and text shadows on text-only layers. Inner
    shadow: inset box shadows (written first). Filters: Layer (`filter`, leaving drop shadows to
    Shadow) and Backdrop (`backdrop-filter`) stacks of blur (4px default), brightness, contrast,
    grayscale, hue rotate, invert, saturate and sepia, reordered by dragging.
  - Selection colors: every colour painted in the selection (fills, text, borders, outlines,
    declared decoration and stroke colours, shadows), the first ten then the rest on request;
    editing one rewrites each place it is set as one step. Inherited text colour is edited
    where it is declared inside the selection, or on the selected layer.
  - Colour picker: an OKHSV area (right-click for classic HSV, remembered per viewer), vertical
    alpha and hue sliders, Previous/New (Previous reverts), OKLCH, HSL and RGB rows with copy,
    a field that takes any CSS colour with arrow keys nudging the number under the caret and
    a format menu (OKLCH, HSL, RGB, Hex; it changes the field, values are stored as hex), the
    eyedropper (`I`), Enter or Esc to close. A colour typed outside sRGB is stored as written
    and shows "Out of gamut"; that badge stores the sRGB colour. The frame's colours show as
    swatches below.
  - Nothing selected: the Page section with the page's canvas colour (see Model).
  - Outline is not offered on frames, whose painting is clipped to the frame; Border keeps a
    Double style; text colour stays in the Text section; Relative sizes are stored as plain
    percentages. Google Fonts come from the server (`canvasFonts.ts`), downloaded once and
    stored as work assets.
- **Export:** the inspector's last section:
  - Rows live on each node, in `CanvasPage.exportSettings` keyed `frame:<id>` or
    `layer:<frame>:<layer>`, saved through `canvas.layout` and undoable. Removing a frame
    or layer drops its rows. With no rows the section is dimmed; clicking it adds 2x
    `@2x` in the last format picked (per user, local storage).
  - `+` adds the first unused of 1x/2x/3x on top (1x under a lone 2x goes below). The
    Size field takes `2x`, `512w`/`512px`, `512h` and `1080p` (shorter side), with
    presets and arrow steps; `0` is refused. The suffix follows the size unless
    customized. A row's Settings hold the suffix, the colour space and PDF quality.
    Several nodes with different rows show "Click to replace mixed export settings".
  - Formats: PNG, JPG, WebP, PDF, and AVIF only where the browser can encode it.
    Images render on a Display P3 canvas (PNG/JPG/WebP carry the profile) at quality
    0.9, capped at 16000 px per side and 256 MP. The node's border box is cropped; a
    layer exports alone on transparency. JPG fills transparency with white.
  - Files are `<label><suffix>.<ext>`: the layer name, else its first 20 text
    characters, else its layer label. Every node × row is its own download. ⌘⇧E exports
    the selection, else every node on the page with rows; nodes without rows use 2x.
  - PDF rows are always 1x, one file per node with pages the node's size; pages are raster
    (High is lossless at 2x, Medium and Low are JPEG at 1.5x and 1x). **Export combined
    PDF** (several nodes, one with a PDF row) orders pages in rows (15% vertical overlap),
    left to right, at the best quality any node asks for, as `Combined.pdf`. The colour-space
    row names the real space (Display P3, sRGB for PDF). Downloads go through the browser.
  - The header's copy menu and the context menu's **Copy as** submenu: PNG (⇧⌘C, at
    the screen's pixel ratio; several nodes are composited with transparent gaps),
    React with Tailwind (⌥T) and React CSS (⌥R) for one node
    (`@synara/shared/designCanvasCode`, shared with `synara_read_design_code`).
- **Comments:** pins anchor to the layer under the click (locked layers included) and move
  with it, kept 2 px inside the layer when it shrinks. With the Comment tool and a thread
  open, the first click only closes it; the composer opens on pointer up. Unsent text asks
  "Discard changes?" before Escape or closing drops it. Each of the user's messages has Edit
  and Delete (the first message's Delete removes the thread). A thread with an agent reply
  newer than `readAt` is unread (a dot on the pin and its row); opening it marks it read.
  Reply, resolve (with an 8 s Undo), reopen, delete. The Comments panel lists every page's
  threads with Search, a Sort and filter menu (Newest first, Oldest first, By page; author
  Anyone/You/Agent; Any page/This page) and a Show resolved toggle kept per execution host;
  a row on another page switches to it and opens the thread. ⇧C, or **Show comments** in the
  zoom menu, hides or shows every pin. **Ask agent** seeds the canvas chat's composer with the
  comment and IDs; the user sends it. The card is placed with the camera's CSS variables so it
  follows a pan or zoom without a render, which an anchored popover would not.
- **Agent activity:** frames an agent wrote, edited or deleted in during the last 40 s get a
  pulsing outline in the agent colour that follows the frame's corner radius, and their label
  row a strip of "rain" dots (two rows, up to 32 columns, running leftward from the frame's
  right edge up to the label) beside the provider's name; both fade in and out over 400 ms and
  go when the agent's turn ends. Reads never light the outline. When an agent starts writing
  to a frame that is mostly out of view (under a quarter of its area on the canvas, the area
  beside the panels and tool strip: a new frame placed to the side, or a sliver at an edge), the
  camera brings it into view through the animated camera, with the frames in view kept as
  context (unless that would zoom out past half the zoom), never zooming in
  (`editor/useCanvasAgentReveal.ts`). It does not move while the user is busy: a gesture, a text
  edit, a comment being written, focus in an editor field, or a press, key or wheel on the
  canvas in the last 1.5 s. Each frame is revealed at most once per agent turn (a turn ends when
  that chat's activity leaves the page). Per-layer reveals come from
  `useCanvasActivityStore.layers`: a read flashes for 1.5 s, a write too with the new layer
  hidden until halfway, an edit for 1.0 s, a delete for 0.8 s where the layer was (its box is
  remembered as the renderer removes it). Flashes are drawn outside React in the agent colour
  (deletes in the destructive colour), clipped to the frame. Pages with agent activity show a
  grayscale rain instead of their icon in both page lists. Reduced motion stops the pulse and
  the rain and turns reveals off.
- **Pages list** (`CanvasPagesSection.tsx`, Layers tab; `PageListPopover.tsx`, the header
  switcher in both layouts): pages and dividers in one order. A page row shows its icon (the
  agent rain while an agent works on it), its name and, on the open page, a check mark after
  the name. Click opens, double-click or F2 renames, `+` adds a page and starts renaming it.
  Rows drag to reorder pages and dividers together (a line shows where the row lands: the
  upper half of a row drops before it, the lower half after it); Alt+↑/↓ moves the focused row
  one step. Right-click on a page: Rename, Add divider below, Icon (one row with a submenu of
  15 icons, Default first once one is set) and Delete page (not offered on the last page:
  native menus have no disabled rows). On a divider: Duplicate and Remove divider; dividers have
  no name. The header switcher shows dividers as lines and page icons and opens the same menus;
  reordering is in the Pages list only. Deleting the open page opens the next page, or the
  previous one when it was last. A frame's right-click menu has **Use as cover** / **Remove
  cover**; it is a library property, not an undo step.
- **Inspector live values:** while the canvas drags or resizes a frame or layer, the
  inspector's X, Y, W and H follow from `canvasLiveGeometry.ts`, an external store only the
  inspector fields subscribe to, so the canvas still renders nothing per pointer move.
- **Known limits:** no multi-selection resize; a rotated layer resizes along its axes but its
  anchor corner is not held fixed; absolute layers move to another frame or the page from the
  layers panel, not by dragging on the canvas; ⌥-drag moves the original until release; a
  hidden layer is not shown before editing its text; there is no pen, shader, image
  generation, design tokens, SVG internals editing or SVG export; reveals use Synara's colours
  and clip to the frame; the reduced-motion preference is the system's; comment threads have
  no mentions, reactions, attachments or author permissions (Synara is single-user). Rich text:
  the other text keys (align, size, weight, line height, letter spacing) act on whole layers and
  not while typing; `<b>`, `<strong>`, `<em>`, `<i>` and line-break `br` layers are not styled
  ranges (their block is not edited in place); a caret alone does not set a style for the next
  typed characters (⌘B with a caret styles the block); `option` text takes no ranges.

## Agent tools

Beta only, like every canvas RPC (`agentGateway/canvasLibraryTools.ts`; every tool
advertises an object input schema). `CANVAS_GUIDE` (`synara_canvas_guide`, just under the
18,000-character cap a test holds) is Synara's design method, in its own words, examples and
structure. Method comes first:

- **Brief before the first write**, posted in chat before any write tool: moods considered,
  the mood chosen and why it is not the first pick, a scene with a 5–6 colour palette (role
  and source object for each), a pair check (the ground is pure white, pure black or a
  neutral the scene justifies, so a saturated accent on a tinted ground fails, and the pair is
  not a listed cliché), type, spacing, direction. The final reply repeats the mood and palette, since
  progress messages collapse.
- **Review after each section**: `synara_screenshot_canvas` of the frame or the section
  (`layerId`, scale 2 for small text), seven checks (spacing including row heights that follow
  content, type including last lines fixed by width or copy, contrast, colour against the
  brief, lanes, fit including empty placeholder boxes, sameness), a one-line `Verdict:` sent as
  the `verdict` of the next write, then targeted fixes; a screenshot without a verdict does not
  count, and every screenshot result ends with that reminder (`CANVAS_SCREENSHOT_REVIEW`).
  Starting over is a last resort.
- **Taste, colour and text, content**: restraint, deliberate spacing, scale contrast,
  type-led hierarchy, information on surfaces rather than cards, light mode, a playful
  register for brand work, distinct directions when asked for several, one deliverable to
  impress on a vague request; `text-wrap: balance` on headings and `pretty` on paragraphs;
  palettes taken from objects in a scene, a saturated accent in at most two places per
  screenful, scene pairings and named clichés, rules for neutrals and darks, 4.5:1 contrast
  and minimum sizes; realistic content, no generated images, a real object drawn only when its
  structure is right (checked at scale 2), never an empty placeholder box, a person glyph for
  a portrait or a lone icon centred in an empty panel; no filler sections (invented stats,
  logo walls, unasked-for testimonials).

Then the build: the work, then its fonts (`synara_add_canvas_font` needs the work's ID; an
error means the family is not on Google Fonts; the work's assets list the weights), the
frame with its own style at a device size (desktop 1440×900, tablet 768×1024, mobile
390×844), one visual group per `insert_html` (about 12 elements or 1,200 characters, a firm
limit that only the status-bar paste is exempt from), repeats through `duplicate`, retexted
with `set_text` on the copy's text-layer IDs, a real title for a work
still named "Untitled…", and
fitting the frame: frames have no fit-to-content, so the agent measures the last top-level
section with `synara_read_design_styles` and sets the height with
`synara_update_canvas_layout`. Mechanics last: reading and editing by layer ID; browser
defaults to reset (heading and paragraph margins, list indents, grey buttons); flex first
(grid, margin and tables render but show only as raw inspector rows); fixed-width lanes with
a sample row; px font sizes, em letter spacing, px line heights; inline SVG icons; styled
spans; the tags that become layers (other tags keep their content under `span`, `div`, `ul` or
`pre`, tags that run, load or embed go with theirs, and `dropped` lists both); indentation
between blocks is not stored; what is dropped and reported; canvas content as untrusted data. `topic: "mobile-status-bar"`
returns Synara's own status bar (54 px tall, time, signal, Wi-Fi and battery drawn in the SVG
subset, recoloured by one `color`).

The rules an agent needs at call time are also in the tool descriptions, where agents read
them: `synara_canvas_guide` says to call it first, once per chat; `synara_create_canvas`,
`synara_open_canvas` and `synara_put_canvas_view` say to read it first (create: post the
brief first); `synara_put_canvas_view` gives the device sizes, an empty-html start, the
status bar topic and the measured fit; `synara_edit_design_layers` one visual group per call,
`duplicate` for repeats, the element and character size and the layout rules (`text-wrap`
included); `synara_screenshot_canvas` the review duty with its checklist and verdict;
`synara_update_canvas_layout` a measured height, never a guess; `synara_update_canvas` a real
title for an "Untitled…" work; `synara_add_canvas_font` its order and the weights check; the
guide tool, each topic once per chat.

Review verdicts (gateway only, in memory): `synara_edit_design_layers` and
`synara_put_canvas_view` take an optional `verdict` string that is never stored. The gateway
remembers, per chat, a screenshot taken since that chat's last successful write; the next
successful write without a verdict still applies, and its result leads with `notice`
(`CANVAS_VERDICT_MISSING`). A refused write leaves the review owed; at most 1,000 chats are
remembered. Each `duplicates[]` entry of an edit result also lists the copy's `textLayers`
(ID and text, up to 20), and `set_text` on an element that is not a text block is refused
with the text layers inside it (the first five, then a count), or with how to add text when
it holds none.

Agent input tolerance (`omitRefusedNulls` in the tool wrapper): the advertised JSON schema
offers `null` for every optional field, as Effect emits it, so agents send `"css": null`. A
null in an optional field the decoder does not let be null (`css`, `beforeId`,
`expectedRevision`, `archived`) is read as absent; fields where null means something
(`parentId`, `folderId`) keep it, and a null where a value is required is still refused. The
contract types are unchanged. A style or attribute edit aimed at a text layer is refused with
the ID and tag of the element that holds it.

| Tool                           | Arguments (beyond `workId`, `pageId`)                                                                                                                                                                                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synara_canvas_guide`          | `topic?`: `guide` (default) or `mobile-status-bar`                                                                                                                                                                                                                                                                                                                                                                             | The guide, or the status bar markup with where to paste it and how to recolour it; any other topic is refused                                                                                                                                                                                                                                                                                                                                                               |
| `synara_read_design_layers`    | `frameId`, `layerId?` (subtree), `depth?` (1–20, default 6), `format?` `tree` (default) or `html`                                                                                                                                                                                                                                                                                                                              | Tree: text, one line per layer: tag, name, ID, W×H from an open window or `?`, text preview with its text-layer ID, `+N children` past the depth, 400-line cap; an inline SVG is one line (`inline SVG viewBox …, N layers inside`) unless read by its `layerId`; a rich text block is one line (`rich text "…" (N styled spans)`) unless read by its `layerId`, which lists the spans and their text layers. HTML: as before, for the frame or the subtree, spans included |
| `synara_find_design_layers`    | `text?`, `name?` (`data-name`), `tag?` (AND; substring, or `*` anchored), `frameId?`, `layerId?`, `limit?` (≤100, default 30)                                                                                                                                                                                                                                                                                                  | `total`, `truncated`, `matches[]`: `frameId`, `layerId`, `tag`, `name`, `textLayerId`, `text`, `path`; an SVG matches, its shapes only inside a search rooted at it; a rich text block matches by all of its text with `textLayerId` its own ID and `styledSpans`, its spans only inside a search rooted at it                                                                                                                                                              |
| `synara_edit_design_layers`    | `edit`: `frameId`, `mutationId`, `expectedRevision?`, `operations[]` (≤100): `set_text` (a text layer, or a text block's element: its whole content becomes one plain text, its spans removed and reported under `dropped`), `set_styles`, `set_frame_styles`, `set_attributes`, `insert_html`, `insert_layers`, `move`, `delete`, `duplicate` (`nodeId`, `parentId?`, `beforeId?`), `replace_html` (`nodeId`, `html`, `css?`) | `revision`, `createdNodeIds`, `duplicates?` (`sourceId`, `newId`, `idMap`), `dropped`                                                                                                                                                                                                                                                                                                                                                                                       |
| `synara_screenshot_canvas`     | `frameId?`, `layerId?` (needs `frameId`; an element), `scale?` 1 or 2, `maxSide?`                                                                                                                                                                                                                                                                                                                                              | PNG of the page, the frame, or the frame cropped to the layer's box with the frame painted around it                                                                                                                                                                                                                                                                                                                                                                        |
| `synara_read_canvas_selection` | none                                                                                                                                                                                                                                                                                                                                                                                                                           | `selection: null` with a reason, or `workId`, `pageId`, `items[]` of frame or layer IDs with element tags                                                                                                                                                                                                                                                                                                                                                                   |
| `synara_read_design_code`      | `frameId`, `layerId?`, `format?` `inline` (default) or `tailwind`                                                                                                                                                                                                                                                                                                                                                              | React component source (`@synara/shared/designCanvasCode`, the editor's Copy as code); inline SVG with React's names (`strokeWidth`) and IDs prefixed per SVG; a rich text block on one line, its spans inline (`Ship <span style={…}>twice as fast</span> today`)                                                                                                                                                                                                          |
| `synara_read_design_styles`    | `frameId`, `layerIds` (1–20 element layers)                                                                                                                                                                                                                                                                                                                                                                                    | Per layer: box in frame pixels and computed styles (49 properties, plus `fill`, `stroke` and `stroke-width` on SVG elements; image URLs as `url(…)`) from an open window                                                                                                                                                                                                                                                                                                    |

`synara_update_canvas_pages` takes the page list operations above (`set_icon`, `add_divider`,
`delete_divider`, `move` of a divider). Every work receipt lists pages as before, with `icon`
when one is set, and the dividers apart as `pageListDividers` when there are any, so an agent
never takes a divider for a page; a divider ID passed as a `pageId` fails as an unknown page.
Agents cannot set a work's cover.

Unchanged: `synara_list_canvases`, `synara_create_canvas`,
`synara_open_canvas`, `synara_read_canvas`, `synara_create_canvas_folder`,
`synara_update_canvas`, `synara_duplicate_canvas`,
`synara_put_canvas_view`, `synara_update_canvas_layout`, `synara_add_canvas_font`,
`synara_import_canvas_asset`, `synara_list_canvas_comments`, `synara_reply_canvas_comment`
(descriptions updated to the method above; schemas and results as before).

Reads (tree, HTML, find, screenshot, code, styles) publish `read` activity; writes publish
`write` (created layer roots, or the whole frame for a put), `edit` (changed layers; a text
edit names the element holding the text, a shape edit its SVG, a styled span's edit its text
block) and `delete` (deleted or replaced layers, already
gone from the clients' frames when the event arrives).

`canvasTurnContext.ts` adds only trusted IDs to each turn: the chat's linked work/page
and, when the composer chip is active, the selected frame and layer IDs with their
tags. A linked turn also carries the load-first rule (`CANVAS_GUIDE_FIRST`: read the guide
once per chat before any other canvas tool and post its brief before the first write) and,
when the work's title is still a placeholder (`CANVAS_PLACEHOLDER_TITLE`, "Untitled…"), a
line asking for a real one; the title itself is not repeated. The
gateway's MCP `instructions` do not carry it: `AgentGateway.test.ts` holds them under 200
characters, because MCP clients repeat them with every tool. Design text, names and comments
stay untrusted data. `synara_read_canvas_selection`
reads the same chip (`canvasChatSelection.ts`, set by the window through
`canvas.setChatSelection` for its own chat) and never reaches further: only the caller's
own chat, only when its canvas is linked to that chat, IDs and tags only.

Screenshots and measurements: the server has no layout engine, so
`canvasRenderRequests.ts` publishes a `render` event; every subscribed Synara window
renders it and the first answer through `canvas.submitRender` wins (20 s timeout for images, 5 s for measuring; an error
when no window is open). The window lays the frame out off screen through the canvas
renderer (`measureCanvasFrameLayers` in `lib/canvasExport.ts`) to measure boxes, then crops
with the export path's view-box crop. A tree read falls back to `?` when no window is open,
it does not answer in time, or an older window answers with an image.

Left out on purpose: design tokens, image generation and design-file import (no guide topics
for either), video export, cloud links, an explicit "finished working" call (the turn's end
clears activity instead), a "fit height" request (agents measure the last section and set the
height with `synara_update_canvas_layout`), cloning a node from inside HTML (`duplicate` and
follow-up edits instead), a font lookup tool (a `synara_add_canvas_font` error and the work's
font assets instead), and per-item partial success (batches stay atomic).

## Verification

Server: `designCanvasInline.test.ts` (also styled text ranges: a span from `insert_html` stored
as a range of a rich block, the strict editor refusal and agent drop of an unsafe span style,
`set_text` on a block replaced by one plain text with the applied edits replaying to the stored
tree, an empty block filled, a non-text element refused, spans counted toward the layer and size
limits; and the inline SVG subset: what is stored as written,
each refused construct refused in the editor and dropped and reported for agents, the
structure, attribute and 1,000-layer checks on every write path, depth and size limits),
`canvasLibraryStore.test.ts` (including the version
2 → 3 asset migration, an edit beside a 2 MiB asset that writes no asset bytes, delta
replay to the stored frame, `duplicate` and `replace_html` with their replayed deltas,
dropped-style reporting against the editor's strict rule, and the named failing
operation), `canvasTurnHistory.test.ts`, `canvasRenderRequests.test.ts` (layer crop and
scale forwarding, measuring, timeouts), `canvasFonts.test.ts`,
`agentGateway/canvasLibraryTools.test.ts` (every tool, the object-schema guard, and the
golden sequence against the handlers: create a frame, insert the card, read the tree,
restyle one button without a revision in a batch with a declaration the sanitizer rejects,
read the tree again with every ID, order and parent unchanged, `dropped` naming the
declaration and the event naming the frame with a delta; plus read/write activity and its
clearing at the turn's end; dividers listed apart from pages and refused as pages; an SVG icon
inserted with refused parts reported, read as one tree line and by its ID, found by tag,
exported as React and edited by shape with the activity naming the SVG; a styled span written,
read as one `rich text` line and by its ID, found by its text as the block, exported inline, its
range retexted with the activity naming the block, and `set_text` on the block reported).
`canvasLibraryStore.test.ts` also covers the page list: dividers added, retried, moved with
pages, re-anchored when their page goes and removed, ID clashes, the 32-divider limit, icons
set, cleared and refused, a newer stored icon key, page colours set, cleared and refused (with
a file written without one loading unchanged), the cover frame as thumbnail with its
fallback and return on undo, page delete, duplicate mapping and the archive refusal, the
thumbnail's fonts and images listed as `previewAssets`, and version 3 files without the new
fields.

Shared: `designCanvasCode.test.ts` (the code generator the editor and
`synara_read_design_code` share, SVG names and per-SVG IDs included, a rich text block on one line
that renders the same text and spans), `designCanvasPages.test.ts` (list order and anchors),
`designCanvasSvg.test.ts` (the element list, value rules, scoping), `designCanvasText.test.ts`
(the text block predicate, runs, normalization: merge, split, unwrap, flatten, hoist, ID
preservation and idempotence, and the commit operations replayed and validated).

Web: `CanvasPageList.browser.tsx` (real drag, key and context-menu events: pages and dividers
in one order with icons, the check and agent rain; drag reorder with the drop line; Alt+arrow
moves; the page and divider menus, icons, Add divider below, rename, delete opening the next
page; the header switcher; Use as cover and Remove cover; the pages splitter, remembered, and
its double-click fit), `CanvasLibraryView.browser.tsx`
(Recent, Files with its trail, Archive; search across folders and its empty state; grid and
list remembered; Move to, folder cycles, the rename dialog), `canvasWorkCache.test.ts` (deltas, including the `duplicate` and `replace_html`
shapes, refetch of one work on a gap, own-write echo, newest-wins), `canvasStores.test.ts`
(activity kinds, per-layer entries, reads leaving the outline alone, `ended`),
`lib/canvasExport.browser.ts` (off-screen measuring, a layer screenshot cropped at scale 1
and 2 within `maxSide`, computed styles), `editor/CanvasLiveUpdate.browser.tsx` (a remote single-layer change keeps
sibling DOM nodes, an in-flight drag preview and an open text edit; back-to-back edits
undo against the latest document), `editor/CanvasCamera.browser.tsx` (first-open fit,
empty pages, per-page cameras, no server writes while idle),
`editor/CanvasGestures.browser.tsx` (pan, wheel zoom, layer and frame drag, resize and
marquee with zero React commits while the pointer moves, measured with a `Profiler`;
cancel; flow reorder; keyboard tree walking and tools),
`inspector/CanvasInspector.browser.tsx` and `inspector/CanvasInspectorSections.browser.tsx`
(real pointer and key events against the in-memory store: rotation and the 90° button, one
undo step for several patches, Shift ×8 and arithmetic, constraints, align and wrap in flex,
flex wrap and line gap, the fill stack with a gradient and a drag reorder, mixed fills,
vertical text alignment, wrap, truncation and italics, Underline, Outline, Text stroke,
shadows, drop shadows and inner shadows, layer and backdrop filters, Selection colors, the
picker's area, Previous, wide colours and the gamut badge, format and space, and font
Favorites), `inspector/inspectorValues.test.ts` and `inspector/inspectorColor.test.ts` (the
pure rules and colour spaces), `lib/designCanvas.browser.ts` and
`designCanvasInline.test.ts` (every declaration the inspector writes passes both sanitizers;
`app-region` is dropped everywhere, and prefixed names outside the inspector's list are
refused in style patches),
`lib/designCanvas.browser.ts` also covers form controls (drawn enabled in the frame's font,
still unfocusable, inactive and untypable; a select showing its option; a design-disabled
control keeping its look) and inline SVG: an icon's box, `currentColor` and
namespaces, refused constructs from a forged tree kept out of the DOM, node identity across a
sibling's restyle, and two SVGs with the same gradient ID keeping their own colours in a
rasterized export, plus one SVG exported alone (pixel checks); `lib/canvasExport.browser.ts` an
SVG in frame, layer and page screenshots and in measurements; `editor/CanvasSvgLayers.browser.tsx`
(real pointer and key events: click, Cmd-click, double-click and Enter keep the whole SVG, one
layers-panel row, a corner resize writing `width`/`height` with zero commits while moving, ⌘D
duplicating it whole with its own ID scope, an SVG document pasted into the frame and beside a
selected SVG, and the inspector's SVG colour without text sections).
`editor/CanvasRichText.browser.tsx` (real key and pointer events: a selected word bolded as one
span and one undo step, ⌘Z inside the edit, undo after it; bold toggled off merging back with no
span left; overlapping bold and italic; ⌘U with a caret on the block; the inspector reading a
mixed range, colouring it while the edit stays open, saved in one step with the restyled span's
ID kept; typing inside a range keeping its style; pasted HTML inserting plain text only; an
agent's restyle of a sibling keeping the caret and the spans; a span never selected by a click,
a Cmd-click or the layers panel; ⌘B on selected blocks, clearing their ranges, and off again).
`editor/CanvasEditorBugs.browser.tsx` (one reproduction per fixed editor bug, against an
in-memory stand-in for the store in `editor/canvasEditorTestHarness.tsx`),
`editor/CanvasEditorInteractions.browser.tsx` (real pointer and key events: frame
body and label clicks, the 4 px tolerance, siblings at the selection's depth, locked layers
on canvas and in the panel, double-click by time and distance with Shift, deep text,
inline frame rename, the 5 px threshold; marquee frame rule, Shift toggle, Space move,
clipping, hidden and locked; 7×7 corners, invisible edges, the badge, a rotated layer, bounds,
a gap handle drag with zero commits; world-delta drags under a wheel pan, Shift axis, ⌥
duplicate, reparenting, selection undo; the Text tool caret, T, Tab/⇧Tab, emptied and
created text in one step, line breaks), `editor/CanvasEditorKeys.browser.tsx`
(ungroup, frame selection, remove flex, clip, opacity digits, others, N, ⇧C, `.`, text keys;
copy with the embedded tree and a paste from another window, paste on top and to replace;
panel indent, slow inside drop, multi-row cross-frame move with undo, frame hide/lock/rename/
reorder, inherited lock dot, dimmed children, ⌘R, ⌥L, icon centring; the Comment tool's
first click and pointer-up composer; agent outline radius, rain, fades, edit and delete
flashes, the pages-list indicator; animated zoom with zero commits, pinch versus Ctrl, pan
end on blur; live inspector X during a frame drag with zero commits),
`editor/CanvasEditorCommands.browser.tsx` (the empty-canvas menu; click, Shift, Alt and Space
drawing; ⌘ arrow resizes and fit or fill from the keys and handle double-clicks; ⌥ align and
⌃⌥ distribute; ⇧Esc and the Deselect row; ⌘⇧X and the Adjust text submenu; toasts; the
sizing badge; Show comments in the zoom menu; dashed flex outlines and the 2 px hover outline;
the cover marker and hidden blocked labels; Alt-click subtree toggles, Tab renames and
Collapse all in the layers panel) and
`editor/CanvasComments.browser.tsx` (also discard confirmation, read on open, message edit
and delete, panel search, filters and the stored toggle, pin clamping, the pin shrinking below
50% zoom, ⇧C), `editor/CanvasAgentReveal.browser.tsx` (an off-screen frame an agent writes
comes into view with the frames in view, a few commits rather than one per animation step, once
per turn; a sliver at the edge is revealed, a half-visible frame is not; never during a text edit
or a drag), `CanvasFrameStrip.browser.tsx` (turn-card
thumbnails and the composer's selection chip with the work's fonts and images), `editor/CanvasAppShortcuts.browser.tsx` (the app's real shortcut resolver and
default bindings on a window capture listener: ⌘B in a text edit bolds, ⌘B / ⌘I / ⌘D / ⌘[ on a
focused canvas run the canvas commands, and outside the canvas the app's commands run), the
Page section and the picker's uncut channel rows in `inspector/CanvasInspector.browser.tsx`,
the Move to tree in `CanvasLibraryView.browser.tsx` and `canvasFolderTree.test.ts`, the Layers
tab's shortcut tooltip in `CanvasSidePanel.browser.tsx`, and the shortcuts sheet's Canvas
section in `shortcutsSheet.test.ts`. Pure modules have unit tests: `canvasShortcuts` (every key,
the digit rule, and every guide press replayed through the rules with every shortcut listed),
`canvasMeasure` (drawn boxes, the size badge, blocked labels), `canvasGestures`,
`canvasSelection` (hit stack, click and drill rules, double-click, locks, marquee rules,
Shift toggle), `canvasLayerDrop` (zones, depth steps, slow inside, frames), `canvasCommands`
(arrange order), `canvasClipboard` (embedding, untrusted trees, paste order, offsets),
`canvasHistory` (groups, replay, lifetime, several inserts in one edit),
`useCanvasTextEditing` (text edits, empty deletes, line breaks, Tab order). Server:
`canvasLibraryStore.test.ts` also covers frame flags and order, message edit and delete
permissions and `mark_read`.

`apps/e2e/src/designCanvas.e2e.test.ts` runs the full flow against an isolated dev
instance whose Codex binary is `apps/e2e/src/harness/codexFixture.mjs` (settings
`providers.codex.binaryPath`, separate `homePath`). The fixture makes real MCP calls
through the authenticated gateway during real turns; the browser drives the real UI.
A second test runs the golden sequence with an open window: a frame, the card, the tree,
a batch with an unknown layer (refused, naming it), the restyle alone without a revision and
the tree again; every layer keeps its ID, order and parent, the tree reads the same but for
the revision, the window's DOM nodes are the same objects before and after, the event
carried the delta, and the turn's read and edit activity ends with the turn.
Check free IPv4/IPv6 ports first and unset an inherited `SYNARA_AUTH_TOKEN` only for
the isolated processes.

```sh
SYNARA_HOME=<scratch> SYNARA_PORT=3911 SYNARA_MODE=web SYNARA_NO_BROWSER=1 \
  VITE_DEV_SERVER_URL=http://localhost:5911 DESIGN_CANVAS_FIXTURE_ROOT=<scratch> \
  bun apps/server/src/index.ts
(cd apps/web && PORT=5911 VITE_WS_URL=ws://localhost:3911 bun run dev)
SYNARA_E2E_DESIGN_ORIGIN=http://127.0.0.1:3911 SYNARA_E2E_DESIGN_WEB=http://localhost:5911 \
  SYNARA_E2E_DESIGN_HOME=<scratch> bun run --cwd apps/e2e test src/designCanvas.e2e.test.ts
```

The fixture proves the transport and tool contracts, not a live model's choices. Live runs
on 2026-11-10 (Claude and Codex: a card with an SVG icon, a screenshot, a layer read, then one
restyle) passed. Live runs on 2026-11-07 against an isolated dev instance (same flow: design two
390×844 screens, then recolor one button) both used the guide, Google Fonts, put,
screenshot and layer-edit tools and changed only the requested layer:

| Provider                              | Turn 1                                         | Turn 2                                        |
| ------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| Claude (`claudeAgent`, default model) | 2 frames (91 and 210 layers), Fraunces + Inter | button restyled by layer edit, 91 layers kept |
| Codex (`gpt-6.1-sol`)                 | 2 frames (91 and 134 layers), Fraunces + Inter | button restyled by layer edit, 91 layers kept |

Claude only sees the gateway's tools when every tool advertises an object input
schema; `canvasLibraryTools.test.ts` guards this. Packaged Electron, remote hosts and
Windows need their own runtime verification.
