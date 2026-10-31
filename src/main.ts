import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { DEFAULT_OPTIONS, loadSettings, type Direction, type Options, type Settings } from "./options";
import { PreviewPane } from "./pane";

interface TabState {
  options: Options;
  pane?: PreviewPane;
  observer: MutationObserver;
  button: HTMLElement;
}

export default class SplitPreviewPlugin extends Plugin {
  options: Options = { ...DEFAULT_OPTIONS };
  previewOpen = false;
  private readonly tabs = new Map<MarkdownView, TabState>();
  private readonly actions = new Map<MarkdownView, HTMLElement>();
  private stopped = false;
  private reconcilePending = false;
  private saveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const { previewOpen, ...options } = loadSettings(await this.loadData());
    this.options = options;
    this.previewOpen = previewOpen;
    this.addSettingTab(new SplitPreviewSettings(this.app, this));
    const command = (id: string, name: string, run: (view: MarkdownView) => void,
      hotkeys?: { modifiers: ("Mod" | "Alt" | "Shift")[]; key: string }[]) => this.addCommand({
      id, name, hotkeys,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || view.getMode() !== "source") return false;
        if (!checking) run(view);
        return true;
      },
    });
    command("toggle", "Toggle preview in all tabs", () => this.setPreviewOpen(!this.previewOpen),
      [{ modifiers: ["Mod", "Alt"], key: "p" }]);
    command("toggle-direction", "Toggle split direction", view => {
      const pane = this.open(view);
      pane?.toggleDirection();
    }, [{ modifiers: ["Mod", "Alt", "Shift"], key: "p" }]);
    command("split-vertical", "Split vertically (left/right)", view => this.open(view)?.setDirection("vertical"));
    command("split-horizontal", "Split horizontally (top/bottom)", view => this.open(view)?.setDirection("horizontal"));
    command("toggle-scroll-sync", "Toggle scroll following", view => this.open(view)?.toggleSync());

    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueReconcile()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueReconcile()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.queueReconcile()));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info instanceof MarkdownView) this.tabs.get(info)?.pane?.scheduleRender();
    }));
    this.registerEvent(this.app.workspace.on("quit", tasks => tasks.add(() => this.saveQueue)));
    this.app.workspace.onLayoutReady(() => this.reconcile());
  }

  setPreviewOpen(open: boolean): void {
    if (this.stopped) return;
    if (this.previewOpen !== open) {
      this.previewOpen = open;
      this.persist();
    }
    this.reconcile();
  }

  private open(view: MarkdownView): PreviewPane | undefined {
    if (view.getMode() !== "source" || !view.file) return;
    this.setPreviewOpen(true);
    return this.tabs.get(view)?.pane;
  }

  private watch(view: MarkdownView): TabState {
    let state = this.tabs.get(view);
    if (!state) {
      this.addAction(view);
      const win = view.contentEl.ownerDocument.defaultView! as Window & typeof globalThis;
      const observer = new win.MutationObserver(() => this.queueReconcile());
      // Mode switches change data-mode/classes or the native display style.
      // Watch only these roots, never text mutations inside either renderer.
      observer.observe(view.containerEl, { attributes: true, attributeFilter: ["data-mode"] });
      observer.observe(view.contentEl, { attributes: true, attributeFilter: ["data-mode"] });
      observer.observe(view.previewMode.containerEl, { attributes: true, attributeFilter: ["style"] });
      state = { options: { ...this.options }, observer, button: this.actions.get(view)! };
      this.tabs.set(view, state);
    }
    return state;
  }

  private attach(view: MarkdownView, state: TabState): PreviewPane | undefined {
    if (!state.pane) {
      const tab = state;
      try {
        const pane = new PreviewPane(view, {
          options: tab.options,
          close: () => this.setPreviewOpen(false),
          changed: options => {
            tab.options = { ...options };
            this.options = { ...options };
            this.persist();
          },
        });
        tab.pane = pane;
        this.addChild(pane);
        tab.button.classList.add("is-active");
        tab.button.setAttribute("aria-pressed", "true");
      } catch (error) {
        console.error("Split Preview: failed to attach preview", error);
        this.removeTab(view);
        new Notice("Split Preview: could not open the preview. See the console for details.");
      }
    }
    return state.pane;
  }

  // Removing a pane for lifecycle reasons must never change saved visibility.
  private removeTab(view: MarkdownView): void {
    const state = this.tabs.get(view);
    if (!state) return;
    this.tabs.delete(view);
    state.observer.disconnect();
    if (state.pane) this.removeChild(state.pane);
    state.button.classList.remove("is-active");
    state.button.setAttribute("aria-pressed", "false");
  }

  private addAction(view: MarkdownView): void {
    if (this.actions.has(view)) return;
    const button = view.addAction("panel-right", "Split Preview: toggle preview in all tabs", () => this.setPreviewOpen(!this.previewOpen));
    button.classList.add("split-preview-action");
    button.setAttribute("aria-pressed", "false");
    this.actions.set(view, button);
  }

  private queueReconcile(): void {
    if (this.stopped || this.reconcilePending) return;
    this.reconcilePending = true;
    queueMicrotask(() => {
      this.reconcilePending = false;
      if (!this.stopped) this.reconcile();
    });
  }

  private reconcile(): void {
    if (this.stopped) return;
    const views = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView) views.add(leaf.view);
    });
    for (const [view, state] of this.tabs) {
      if (!views.has(view) || !view.file || !this.previewOpen) this.removeTab(view);
      else if (view.getMode() !== "source") {
        if (state.pane) this.removeChild(state.pane);
        state.pane = undefined;
      }
    }
    for (const [view, button] of this.actions) {
      if (!views.has(view)) {
        button.remove();
        this.actions.delete(view);
      }
    }
    for (const view of views) {
      this.addAction(view);
      const button = this.actions.get(view)!;
      button.classList.toggle("is-active", this.previewOpen);
      button.setAttribute("aria-pressed", String(this.previewOpen));
      if (!this.previewOpen || !view.file) continue;
      // Observe Reading views too, so their first transition into editing gets
      // a preview even if they have never had a pane in this session.
      const state = this.watch(view);
      if (view.getMode() === "source") this.attach(view, state)?.renderNow();
    }
  }

  persist(): void {
    const snapshot: Settings = { ...this.options, previewOpen: this.previewOpen };
    this.saveQueue = this.saveQueue.then(() => this.saveData(snapshot)).catch(error => {
      console.error("Split Preview: could not save settings", error);
      new Notice("Split Preview: could not save settings.");
    });
  }

  onunload(): void {
    this.stopped = true;
    for (const view of this.tabs.keys()) this.removeTab(view);
    for (const button of this.actions.values()) button.remove();
    this.actions.clear();
  }
}

class SplitPreviewSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SplitPreviewPlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Show preview in all tabs")
      .setDesc("Share preview visibility across this vault's tabs and restore it after restarting Obsidian.")
      .addToggle(toggle => toggle.setValue(this.plugin.previewOpen).onChange(value => this.plugin.setPreviewOpen(value)));
    this.containerEl.createEl("p", { text: "The following settings apply to previews opened afterward. You can also use the toolbar in each tab." });
    new Setting(this.containerEl).setName("Split direction").setDesc("The last direction and split ratio are remembered.")
      .addDropdown(dropdown => dropdown.addOption("vertical", "Vertical (left/right)").addOption("horizontal", "Horizontal (top/bottom)")
        .setValue(this.plugin.options.direction).onChange(value => {
          this.plugin.options.direction = value as Direction;
          this.plugin.persist();
        }));
    new Setting(this.containerEl).setName("Follow editor scroll").setDesc("Align the preview with the source position visible in the editor.")
      .addToggle(toggle => toggle.setValue(this.plugin.options.syncScroll).onChange(value => {
        this.plugin.options.syncScroll = value;
        this.plugin.persist();
      }));
    new Setting(this.containerEl).setName("Preview update delay").setDesc("Delay after typing, in milliseconds. Increase this to reduce work on long notes.")
      .addSlider(slider => slider.setLimits(0, 1000, 50).setValue(this.plugin.options.refreshDelay).setDynamicTooltip()
        .onChange(value => {
          this.plugin.options.refreshDelay = value;
          this.plugin.persist();
        }));
    this.containerEl.createEl("p", { text: "To customize shortcuts, search for Split Preview in Settings → Hotkeys. Defaults: Ctrl/Cmd + Alt + P (toggle preview), Ctrl/Cmd + Alt + Shift + P (change direction)." });
  }
}
