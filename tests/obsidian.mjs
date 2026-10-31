import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

// Only ever launch a separate profile and disposable vault. No user vault access.
const root = await mkdtemp(join(tmpdir(), "split-preview-obsidian-"));
const profile = join(root, "profile");
const vault = join(root, "vault");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let browser;
let page;
let launchLog = "";
const errors = [];

async function startApp() {
  launchLog = "";
  child = spawn(process.env.OBSIDIAN_BIN ?? "/opt/Obsidian/obsidian", [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-sandbox", "--disable-gpu", "--no-first-run",
  ], { env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") }, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", error => launchLog += error.message);
  child.stdout.on("data", data => launchLog += data);
  child.stderr.on("data", data => launchLog += data);
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(launchLog)?.[1];
    if (endpoint) break;
    if (child.exitCode !== null) throw new Error(launchLog);
    await pause(200);
  }
  if (!endpoint) throw new Error(`Obsidian did not start: ${launchLog}`);
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent("page");
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => !!window.app?.vault?.adapter?.basePath);
  assert.equal(await page.evaluate(() => app.vault.adapter.basePath), vault);
  await page.waitForFunction(() => app.workspace.layoutReady);
  const trust = page.getByRole("button", { name: "Trust author and enable plugins" });
  if (await trust.count()) await trust.click();
  await page.evaluate(async () => { await app.plugins.enablePlugin("split-preview"); });
  await page.setViewportSize({ width: 1400, height: 1000 });
}

async function stopApp() {
  await browser?.close();
  browser = undefined;
  page = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  child = undefined;
}

async function waitSaved(previewOpen) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const settings = await readFile(join(vault, ".obsidian/plugins/split-preview/data.json"), "utf8")
      .then(JSON.parse).catch(() => null);
    if (settings?.previewOpen === previewOpen) return;
    await pause(50);
  }
  assert.fail(`Preview visibility was not saved as ${previewOpen}`);
}

async function restartApp() {
  await page.evaluate(async () => { await app.workspace.requestSaveLayout.run(); });
  await stopApp();
  await startApp();
}

try {
  await mkdir(profile, { recursive: true });
  await mkdir(join(vault, ".obsidian/plugins"), { recursive: true });
  await cp("dist/split-preview", join(vault, ".obsidian/plugins/split-preview"), { recursive: true });
  await cp("examples", vault, { recursive: true });
  await writeFile(join(profile, "obsidian.json"), JSON.stringify({
    vaults: { a15a17b1e5000001: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true,
  }));
  await writeFile(join(vault, ".obsidian/community-plugins.json"), '["split-preview"]');
  await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({
    livePreview: false, readableLineLength: false, showInlineTitle: true,
  }));
  await startApp();
  const source = Array.from({ length: 50 }, (_, i) => [
    `## Section ${i + 1}`, "", `Paragraph ${i + 1}. **Bold**, [[second|internal link]], $E = mc^2$.`, "",
    i % 4 === 0 ? "![[sample.svg]]\n" : "A long line that wraps as the pane gets narrower. ".repeat(8), "",
    "- first item", "- second item", "", "```js", `console.log(${i + 1});`, "```", "",
  ].join("\n")).join("\n");
  await page.evaluate(async source => {
    const file = await app.vault.create("long.md", source);
    await app.workspace.getLeaf(false).openFile(file, { state: { mode: "source", source: true } });
  }, source);

  const command = id => page.evaluate(id => app.commands.executeCommandById(`split-preview:${id}`), id);
  const countLeaves = () => page.evaluate(() => app.workspace.getLeavesOfType("markdown").length);
  const layout = () => page.evaluate(() => {
    const content = app.workspace.activeLeaf.view.contentEl;
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      source: rect(content.querySelector(":scope > .markdown-source-view")),
      preview: rect(content.querySelector(".split-preview-native")),
      pane: rect(content.querySelector(".split-preview-pane")),
      divider: rect(content.querySelector(".split-preview-divider")),
      direction: content.dataset.splitPreviewDirection,
    };
  });
  const baseline = await countLeaves();
  await command("toggle");
  await page.locator(".split-preview-native h2").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".split-preview-native img")?.naturalWidth > 0);
  assert.equal(await countLeaves(), baseline, "Opening preview must not create a leaf/tab");
  const vertical = await layout();
  assert.equal(vertical.direction, "vertical");
  assert(vertical.source.width > 250 && vertical.preview.width > 250, "Both sides are visible");
  assert(vertical.pane.x >= vertical.source.x + vertical.source.width, "Preview is to the right");
  assert(Math.abs(vertical.pane.y - vertical.source.y) < 1, "Side-by-side top edges align");
  assert.equal(await page.evaluate(() => app.workspace.activeLeaf.view.editor.getValue()), source);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/vertical.png" });
  console.log("PASS same-tab vertical layout and native rendering");

  // Actual key dispatch through Obsidian's command/hotkey system.
  await page.locator(".markdown-source-view .cm-content").click();
  await page.keyboard.press("Control+Alt+Shift+p");
  await page.waitForFunction(() => document.querySelector(".split-preview-host")?.dataset.splitPreviewDirection === "horizontal");
  const horizontal = await layout();
  assert(horizontal.pane.y >= horizontal.source.y + horizontal.source.height, "Preview is below the editor");
  assert(horizontal.source.height > 200 && horizontal.preview.height > 150);
  assert(Math.abs(horizontal.pane.width - horizontal.source.width) < 1);
  await page.screenshot({ path: "test-results/horizontal.png" });
  console.log("PASS shortcut and horizontal layout");

  const divider = page.locator(".split-preview-divider");
  await divider.focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await divider.getAttribute("aria-valuenow"), "48");
  await page.keyboard.press("Enter");
  assert.equal(await divider.getAttribute("aria-valuenow"), "50");
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 8 });
  await page.mouse.up();
  assert(Number(await divider.getAttribute("aria-valuenow")) < 45);
  await divider.focus();
  await page.keyboard.press("Enter");
  console.log("PASS pointer and keyboard resizing");

  await command("split-vertical");
  await page.evaluate(() => {
    const editor = app.workspace.activeLeaf.view.editor;
    editor.replaceRange("Edited immediately\n\n", { line: 0, ch: 0 });
  });
  await page.waitForFunction(() => document.querySelector(".split-preview-native")?.textContent.includes("Edited immediately"));
  await page.evaluate(() => {
    const scroller = document.querySelector(".split-preview-host > .markdown-source-view .cm-scroller");
    scroller.scrollTop = scroller.scrollHeight * 0.45;
  });
  await page.waitForFunction(() => {
    const view = app.workspace.activeLeaf.view;
    return view.currentMode.getScroll() > 100 && Math.abs(view.currentMode.getScroll() - view.previewMode.getScroll()) < 3;
  });
  const positions = await page.evaluate(() => {
    const view = app.workspace.activeLeaf.view;
    return { source: view.currentMode.getScroll(), preview: view.previewMode.getScroll() };
  });
  console.log("PASS unsaved edits and source-line scroll following", positions);

  await command("toggle-scroll-sync");
  await pause(300);
  const before = await page.evaluate(() => app.workspace.activeLeaf.view.previewMode.getScroll());
  await page.evaluate(() => {
    document.querySelector(".split-preview-host > .markdown-source-view .cm-scroller").scrollTop += 800;
  });
  await pause(500);
  assert(Math.abs(await page.evaluate(() => app.workspace.activeLeaf.view.previewMode.getScroll()) - before) < 2);
  const sourceBefore = await page.evaluate(() => app.workspace.activeLeaf.view.currentMode.getScroll());
  await page.evaluate(() => document.querySelector(".split-preview-native .markdown-preview-view").scrollTop += 500);
  await pause(200);
  assert(Math.abs(await page.evaluate(() => app.workspace.activeLeaf.view.currentMode.getScroll()) - sourceBefore) < 1);
  await command("toggle-scroll-sync");
  await page.waitForFunction(() => {
    const view = app.workspace.activeLeaf.view;
    return Math.abs(view.currentMode.getScroll() - view.previewMode.getScroll()) < 3;
  });
  console.log("PASS optional one-way scroll following");

  // Same leaf, different file; no stale Markdown or link context.
  await page.evaluate(async () => {
    await app.workspace.activeLeaf.openFile(app.vault.getAbstractFileByPath("second.md"));
  });
  await page.waitForFunction(() => document.querySelector(".split-preview-native")?.textContent.includes("Second note"));
  assert.equal(await countLeaves(), baseline);
  await page.evaluate(async () => {
    const leaf = app.workspace.activeLeaf;
    await leaf.setViewState({ type: "markdown", state: { file: "second.md", mode: "preview" } });
  });
  await page.waitForFunction(() => !document.querySelector(".split-preview-host"));
  assert(await page.locator(".markdown-reading-view").first().isVisible(), "Native reading mode survives suspension");
  await page.evaluate(async () => {
    await app.workspace.activeLeaf.setViewState({ type: "markdown", state: { file: "second.md", mode: "source", source: true } });
  });
  await page.locator(".split-preview-native").waitFor();
  console.log("PASS file navigation and reading/source mode transitions");

  // The split preview is for reading; the source buffer owns all task edits.
  assert(await page.locator(".split-preview-native input.task-list-item-checkbox").isDisabled());
  await page.evaluate(() => {
    const editor = app.workspace.activeLeaf.view.editor;
    editor.replaceRange("x", { line: 2, ch: 3 }, { line: 2, ch: 4 });
  });
  await page.waitForFunction(() => document.querySelector(".split-preview-native input.task-list-item-checkbox")?.checked);
  console.log("PASS source task changes update the read-only checkbox");

  await page.locator(".markdown-source-view .cm-content").click();
  await page.keyboard.press("Control+Alt+p");
  await page.waitForFunction(() => !document.querySelector(".split-preview-host"));
  assert.equal(await countLeaves(), baseline);
  assert(!(await page.locator(".markdown-reading-view").first().isVisible()));
  await command("toggle");
  await page.evaluate(async () => {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(app.vault.getAbstractFileByPath("long.md"), { state: { mode: "source", source: true } });
  });
  await page.locator(".workspace-leaf.mod-active .split-preview-native").waitFor();
  assert.equal(await page.locator(".split-preview-pane").count(), 2, "New tabs inherit the shared open state");
  assert.equal(await countLeaves(), baseline + 1, "The plugin does not create extra tabs");
  await command("split-horizontal");
  await page.locator('.workspace-leaf.mod-active button[aria-label="Close preview in all tabs"]').click();
  await page.waitForFunction(() => !document.querySelector(".split-preview-pane"));
  await waitSaved(false);
  assert.equal(await page.locator('.split-preview-action[aria-pressed="true"]').count(), 0);
  await page.locator(".workspace-leaf.mod-active .split-preview-action").click();
  await page.waitForFunction(() => document.querySelectorAll(".split-preview-pane").length === 2);
  await waitSaved(true);
  // Existing panes have their own layout defaults; they must not overwrite the
  // global open state when saving a layout change from an older pane.
  await command("toggle-direction");
  await waitSaved(true);
  assert.equal(await page.locator(".split-preview-pane").count(), 2);
  await page.evaluate(() => app.workspace.activeLeaf.detach());
  await page.waitForFunction(() => document.querySelectorAll(".split-preview-pane").length === 1);
  await waitSaved(true);
  console.log("PASS shared visibility, new tabs, toolbar close, and closed-tab cleanup");

  await page.evaluate(async () => { await app.plugins.disablePlugin("split-preview"); });
  await page.waitForFunction(() => !document.querySelector(".split-preview-pane, .split-preview-divider, .split-preview-action"));
  assert(!(await page.locator(".markdown-reading-view").first().isVisible()));
  await page.evaluate(async () => {
    await app.workspace.activeLeaf.setViewState({ type: "markdown", state: { file: "second.md", mode: "preview" } });
  });
  assert(await page.locator(".markdown-reading-view").first().isVisible());
  assert(!(await page.locator(".markdown-reading-view input.task-list-item-checkbox").isDisabled()), "Native task interaction is restored");
  await waitSaved(true);
  await page.evaluate(async () => { await app.plugins.enablePlugin("split-preview"); });
  assert.equal(await page.locator(".split-preview-pane").count(), 0, "Reading mode stays intact after restoring the open preference");
  await page.evaluate(async () => {
    await app.workspace.activeLeaf.setViewState({ type: "markdown", state: { file: "second.md", mode: "source", source: true } });
  });
  await page.locator(".split-preview-native").waitFor();
  console.log("PASS plugin reload preserves visibility and observes initially reading tabs");

  await page.evaluate(async () => {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(app.vault.getAbstractFileByPath("long.md"), { state: { mode: "source", source: true } });
  });
  await page.locator(".workspace-leaf.mod-active .split-preview-native").waitFor();
  await waitSaved(true);
  await restartApp();
  await page.locator(".workspace-leaf.mod-active .split-preview-native").waitFor();
  assert.equal(await countLeaves(), 2, "Restoring visibility must not create more tabs");
  await page.evaluate(() => {
    const leaf = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.getViewState().state.file === "second.md");
    app.workspace.setActiveLeaf(leaf, { focus: true });
  });
  await page.waitForFunction(() => app.workspace.activeLeaf.view.file?.path === "second.md");
  await page.locator(".workspace-leaf.mod-active .split-preview-native").waitFor();
  console.log("PASS open state survives a full app restart and switching restored tabs");

  // Queued settings writes must preserve the latest user action.
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) app.commands.executeCommandById("split-preview:toggle");
  });
  await page.waitForFunction(() => !document.querySelector(".split-preview-pane"));
  await waitSaved(false);
  await restartApp();
  assert.equal(await page.locator(".split-preview-pane").count(), 0, "Closed state survives a full app restart");
  await page.evaluate(async () => {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(app.vault.getAbstractFileByPath("long.md"), { state: { mode: "source", source: true } });
  });
  assert.equal(await page.locator(".split-preview-pane").count(), 0, "New tabs also retain the closed state");
  await command("toggle");
  await page.locator(".workspace-leaf.mod-active .split-preview-native").waitFor();
  console.log("PASS rapid toggles, persisted closed state, and re-enabling after restart");
  assert.deepEqual(errors, [], "No uncaught errors in Obsidian");
  console.log("PASS no runtime errors");
  console.log(`Disposable test vault: ${vault}`);
} catch (error) {
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/launch.log", launchLog);
  if (page) {
    await page.screenshot({ path: "test-results/failure.png" }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({
      content: window.app?.workspace?.activeLeaf?.view?.contentEl?.outerHTML,
      mode: window.app?.workspace?.activeLeaf?.view?.getMode?.(),
    })).catch(() => ({}));
    await writeFile("test-results/failure.json", JSON.stringify({ root, errors, ...diagnostic }, null, 2));
  }
  throw error;
} finally {
  await stopApp();
}
