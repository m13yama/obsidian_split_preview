# Split Preview

An Obsidian plugin that displays editable Markdown and its rendered preview **inside the same tab**. Opening the preview does not create a new tab or split the workspace.

## Usage

1. Open a Markdown note in Source mode.
2. Press `Ctrl + Alt + P` (`Cmd + Option + P` on macOS), or click the **Split Preview** button in the tab header. This enables the preview in all Markdown editing tabs in the current vault. Repeat to close all previews.
3. Press `Ctrl + Alt + Shift + P` (`Cmd + Option + Shift + P` on macOS), or use the preview toolbar to change the split direction.

| Action | Result |
| --- | --- |
| Vertical split | Editor on the left, preview on the right |
| Horizontal split | Editor above, preview below |
| Drag the divider | Resize the editor to between 20% and 80% of the available space |
| Double-click the divider / reset button | Restore a 50:50 split |
| Arrow keys while the divider is focused | Resize by 2%; hold Shift for 10%. Use Left/Right for a vertical divider and Up/Down for a horizontal divider |
| Enter / Home / End on the divider | Set the editor to 50% / 20% / 80% |
| Link button | Toggle scroll following from the editor to the preview |
| Close button | Hide previews in all tabs and focus the current editor |

The default hotkeys use modifiers to avoid ordinary typing and common editing shortcuts. If your OS or another plugin already uses them, change or remove them in **Settings → Hotkeys → Split Preview**. The plugin registers regular Obsidian commands and does not intercept keyboard events globally.

The command palette also provides **Split vertically**, **Split horizontally**, and **Toggle scroll following**. Commands are available while editing a Markdown note. Both Source mode and Live Preview are supported.

## Behavior

- Preview visibility is shared across all tabs in the current vault. Opening or closing it from any tab updates existing editing tabs and applies to tabs opened or activated afterward.
- The open/closed preference is saved immediately in the plugin's `data.json` and restored after restarting Obsidian or re-enabling the plugin. Closing a tab, switching to Reading view, and plugin cleanup do not reset this preference. New installations and older settings without a saved preference start closed.
- You can also change shared visibility with **Settings → Split Preview → Show preview in all tabs**. Settings are local to each vault; separate vaults keep separate preferences.
- Each pane still has its own split direction, size, and scroll-following state. The last direction, ratio, and scroll-following setting become the defaults for newly created panes, including after restarting Obsidian.
- Edits appear after a configurable delay, defaulting to 150ms. Rendering uses the editor buffer without waiting for the file to be saved.
- The preview uses Obsidian's native renderer for internal links, embeds, images, tables, math, and code blocks.
- Task checkboxes in the split preview are display-only. Edit tasks in the source; regular checkbox interaction is restored when returning to Reading view.
- Scroll following uses Obsidian's `getScroll()` / `applyScroll()` APIs to exchange fractional source-line positions instead of matching percentages of document height. Position accuracy inside long blocks and folded content follows the native renderer's behavior.
- Following is one-way. Scrolling the preview does not move the editor. With following enabled, the next editor scroll or content update aligns the preview again. Disable following to keep the preview at another position.
- Reading view temporarily suspends the split for that tab. Returning to editing shows the preview if the shared preference is enabled. Opening another file in the same tab updates the preview to that file.
- Closing the preview or tab, or disabling the plugin, removes its added DOM, event listeners, observers, and timers.

## Installation

Copy the built `dist/split-preview/` folder into your vault as `.obsidian/plugins/split-preview/`. It contains these three files:

```text
.obsidian/plugins/split-preview/
├── main.js
├── manifest.json
└── styles.css
```

Restart Obsidian or reload the plugin list, then enable **Split Preview** under **Settings → Community plugins**.

## Development

Use Node.js 22.18 or later.

```sh
npm ci
npm run check
npm run test:obsidian
```

`npm run build` type-checks the source, bundles the plugin, and prepares the distribution folder. `npm run dev` watches the source and rebuilds `main.js`.

`npm run test:obsidian` launches `/opt/Obsidian/obsidian` with a temporary profile and a disposable vault. Set `OBSIDIAN_BIN` for a different installation path. The test does not modify existing user vaults or settings. Screenshots are saved in `test-results/`. A graphical environment is required.

The real-app tests cover same-tab vertical and horizontal layouts, hotkeys, pointer and keyboard resizing, unsaved edits, source-line scroll following, disabling following, file navigation, Reading/Source transitions, shared visibility across existing and new tabs, and cleanup on tab closure and plugin unload. They also relaunch Obsidian to verify that both open and closed preferences survive a full restart. The tested environment is Obsidian 1.12.7 on Linux; other platforms and third-party themes have not been tested.

The implementation uses the public `MarkdownView.previewMode` and `MarkdownSubView` APIs and temporarily places the native preview inside a pane in the tab. It does not replace native methods or create another editor instance. CSS is scoped to the open split. Themes or plugins that substantially alter Obsidian's DOM or editor layout may need separate compatibility testing.

API reference: [Obsidian TypeScript API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).
