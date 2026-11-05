# Third-party notices (SynBot kit)

The SynBot kit is ported from HoloBot's `packages/ui` (tokens, components, mascots). It keeps
HoloBot's third-party material, listed here. HoloBot's liquid-metal shader is not part of the port.

## Hugeicons (free, stroke rounded)

The icons in `icons/` (`approve`, `arrow-down`, `arrow-left`, `arrow-right`, `branch`, `check`,
`chevron-down`, `close`, `copy`, `deny`, `file`, `folder`, `loading`, `more`, `plus`, `search`,
`send`, `settings`, `sidebar-right`, `star`, `stop`, `undo`) are Hugeicons free icons
(https://hugeicons.com), taken from the npm package `@hugeicons/core-free-icons` 4.3.5
(repository https://github.com/hugeicons/hugeicons, directory `packages/core-free-icons`):
`CheckmarkCircle02Icon` (approve), `ArrowDown02Icon` (arrow-down), `ArrowLeft01Icon`,
`ArrowRight01Icon`, `GitBranchIcon` (branch), `Tick02Icon` (check), `ArrowDown01Icon`
(chevron-down), `Cancel01Icon` (close), `CancelCircleIcon` (deny),
`File01Icon` (file), `Folder01Icon` (folder), `Loading03Icon` (loading), `MoreHorizontalIcon`
(more), `PlusSignIcon` (plus), `Search01Icon` (search), `SentIcon` (send), `Settings01Icon`
(settings), `SidebarRightIcon` (sidebar-right), `StarIcon` (star), `StopIcon` (stop), `Undo02Icon`
(undo), and the copy icon, as listed in HoloBot's `packages/ui/NOTICES.md`. Their path data was
written out as plain 24x24 SVG files, unchanged.

```
MIT License

Copyright (c) 2025 Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BotAvatarsKit (Libraries.dev)

The clover, rounded-square and blob mascot outlines in `botShapes.ts` are SVG path data from
BotAvatarsKit (https://github.com/Jakubantalik/Libraries.dev, `packages/bot-avatars`,
`BotAvatarShapes.swift`), unchanged.

```
MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## HoloBot

SynBot's face (`assets/synbot-ghost-*.webp`) is HoloBot's chrome logo render
(`assets/brand/logo-chrome-1024.png` in the HoloBot repository), cut out of its black square and
scaled to 48, 96, 192 and 384 px, ported to SynBot at the owner's request.
