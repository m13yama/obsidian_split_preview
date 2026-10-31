import { Component, type MarkdownView, setIcon, setTooltip } from "obsidian";
import { clampRatio, type Direction, type Options } from "./options";

export interface PaneHost {
  options: Options;
  close: () => void;
  changed: (options: Options) => void;
}

/** Borrows this view's native preview; never creates a WorkspaceLeaf or editor. */
export class PreviewPane extends Component {
  readonly view: MarkdownView;
  readonly options: Options;
  private readonly host: PaneHost;
  private readonly content: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly win: Window;
  private pane!: HTMLElement;
  private divider!: HTMLElement;
  private directionButton!: HTMLButtonElement;
  private syncButton!: HTMLButtonElement;
  private marker!: Comment;
  private resizeObserver?: ResizeObserver;
  private mutationObserver?: MutationObserver;
  private renderTimer = 0;
  private syncFrame = 0;
  private syncUntil = 0;
  private disposed = false;
  private pointerId: number | null = null;
  private readonly disabledTasks = new Set<HTMLInputElement>();

  constructor(view: MarkdownView, host: PaneHost) {
    super();
    this.view = view;
    this.host = host;
    this.options = { ...host.options };
    this.content = view.contentEl;
    this.preview = view.previewMode.containerEl;
    this.win = this.content.ownerDocument.defaultView!;
  }

  onload(): void {
    const doc = this.content.ownerDocument;
    this.marker = doc.createComment("split-preview-original-position");
    this.preview.before(this.marker);
    this.pane = doc.createElement("section");
    this.pane.className = "split-preview-pane";
    this.pane.setAttribute("aria-label", "Markdown preview");
    const toolbar = this.pane.createDiv("split-preview-toolbar");
    toolbar.createSpan({ cls: "split-preview-title", text: "Preview" });
    this.directionButton = this.button(toolbar, "", "", () => this.toggleDirection());
    this.syncButton = this.button(toolbar, "", "", () => this.toggleSync());
    this.button(toolbar, "rotate-ccw", "Reset split to 50:50", () => this.setRatio(0.5, true));
    this.button(toolbar, "x", "Close preview in all tabs", () => {
      this.host.close();
      this.view.editor.focus();
    });

    this.divider = doc.createElement("div");
    this.divider.className = "split-preview-divider";
    this.divider.tabIndex = 0;
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-label", "Resize editor and preview");
    this.divider.setAttribute("aria-valuemin", "20");
    this.divider.setAttribute("aria-valuemax", "80");
    setTooltip(this.divider, "Drag or use arrow keys to resize. Double-click to reset");

    this.content.append(this.divider, this.pane);
    this.pane.append(this.preview);
    this.preview.classList.add("split-preview-native");
    this.content.classList.add("split-preview-host");
    this.updateLayout();

    // Scroll events do not bubble. Capture only the source scroller, so scrolling
    // an embed or the preview can never drive the editor or start a feedback loop.
    this.registerDomEvent(this.content, "scroll", event => {
      const target = event.target as HTMLElement | null;
      if (target?.matches?.(".cm-scroller") && !this.pane.contains(target)) this.queueSync();
    }, { capture: true, passive: true });
    this.registerDomEvent(this.divider, "pointerdown", event => this.startResize(event));
    this.registerDomEvent(this.divider, "pointermove", event => this.resize(event));
    this.registerDomEvent(this.divider, "pointerup", () => this.endResize());
    this.registerDomEvent(this.divider, "pointercancel", () => this.endResize());
    this.registerDomEvent(this.divider, "lostpointercapture", () => this.endResize());
    this.registerDomEvent(this.divider, "dblclick", () => this.setRatio(0.5, true));
    this.registerDomEvent(this.divider, "keydown", event => this.resizeByKey(event));
    this.registerDomEvent(this.preview, "load", () => this.queueSync(250), true);

    // Follow delayed image/diagram rendering without continuous polling.
    const ResizeObserverClass = (this.win as Window & typeof globalThis).ResizeObserver;
    this.resizeObserver = new ResizeObserverClass(() => this.queueSync(250));
    this.resizeObserver.observe(this.pane);
    const sizer = this.preview.querySelector(".markdown-preview-sizer");
    if (sizer) this.resizeObserver.observe(sizer);
    const MutationObserverClass = (this.win as Window & typeof globalThis).MutationObserver;
    this.mutationObserver = new MutationObserverClass(records => {
      if (records.some(record => record.type === "childList" || record.type === "characterData")) {
        this.updateTasks();
        this.queueSync(150);
      }
    });
    this.mutationObserver.observe(this.preview, { childList: true, subtree: true, characterData: true });
    this.updateTasks();
    this.renderNow();
  }

  private updateTasks(): void {
    // Native Reading view writes checkbox edits into its own buffer. In a split
    // the source buffer is authoritative, so expose these checkboxes read-only.
    // Restore native interaction when returning the preview to Obsidian.
    for (const task of this.disabledTasks) {
      if (!this.preview.contains(task)) {
        task.disabled = false;
        this.disabledTasks.delete(task);
      }
    }
    for (const task of this.preview.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox:not(:disabled)")) {
      task.disabled = true;
      this.disabledTasks.add(task);
    }
  }

  private button(parent: HTMLElement, icon: string, label: string, run: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon" });
    button.type = "button";
    if (icon) setIcon(button, icon);
    if (label) setTooltip(button, label);
    this.registerDomEvent(button, "click", run);
    return button;
  }

  scheduleRender(): void {
    if (this.disposed) return;
    this.win.clearTimeout(this.renderTimer);
    this.renderTimer = this.win.setTimeout(() => this.renderNow(), this.options.refreshDelay);
  }

  renderNow(): void {
    this.win.clearTimeout(this.renderTimer);
    if (this.disposed || this.view.getMode() !== "source" || !this.view.file) return;
    const text = this.view.editor.getValue();
    if (this.view.previewMode.get() !== text) this.view.previewMode.set(text, false);
    this.queueSync(600);
  }

  queueSync(settleMs = 0): void {
    if (this.disposed || !this.options.syncScroll) return;
    this.syncUntil = Math.max(this.syncUntil, this.win.performance.now() + settleMs);
    if (this.syncFrame) return;
    const sync = () => {
      this.syncFrame = 0;
      if (this.disposed || !this.options.syncScroll || this.view.getMode() !== "source") return;
      if (this.pane.getBoundingClientRect().width === 0) return;
      // These public APIs exchange fractional source lines, accounting for
      // wrapping, folded sections, and rendered blocks of different heights.
      const line = this.view.currentMode.getScroll();
      if (Number.isFinite(line) && line >= 0) this.view.previewMode.applyScroll(line);
      if (this.win.performance.now() < this.syncUntil) this.syncFrame = this.win.requestAnimationFrame(sync);
    };
    this.syncFrame = this.win.requestAnimationFrame(sync);
  }

  toggleDirection(): void {
    this.setDirection(this.options.direction === "vertical" ? "horizontal" : "vertical");
  }

  setDirection(direction: Direction): void {
    this.options.direction = direction;
    this.updateLayout();
    this.host.changed(this.options);
    this.queueSync(300);
  }

  toggleSync(): void {
    this.options.syncScroll = !this.options.syncScroll;
    this.updateLayout();
    this.host.changed(this.options);
    this.queueSync(300);
  }

  private setRatio(ratio: number, save = false): void {
    this.options.ratio = clampRatio(ratio);
    this.content.style.setProperty("--split-preview-ratio", `${this.options.ratio}fr`);
    this.content.style.setProperty("--split-preview-rest", `${1 - this.options.ratio}fr`);
    this.divider.setAttribute("aria-valuenow", String(Math.round(this.options.ratio * 100)));
    if (save) this.host.changed(this.options);
    this.queueSync(200);
  }

  private updateLayout(): void {
    this.content.dataset.splitPreviewDirection = this.options.direction;
    this.divider.setAttribute("aria-orientation", this.options.direction);
    this.setRatio(this.options.ratio);
    setIcon(this.directionButton, this.options.direction === "vertical" ? "rows-2" : "columns-2");
    setTooltip(this.directionButton, this.options.direction === "vertical" ? "Split horizontally (top/bottom)" : "Split vertically (left/right)");
    setIcon(this.syncButton, this.options.syncScroll ? "link" : "unlink");
    this.syncButton.setAttribute("aria-pressed", String(this.options.syncScroll));
    setTooltip(this.syncButton, this.options.syncScroll ? "Disable scroll following" : "Enable scroll following");
  }

  private startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.divider.setPointerCapture(event.pointerId);
    this.divider.focus({ preventScroll: true });
    this.content.classList.add("split-preview-resizing");
  }

  private resize(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    const rect = this.content.getBoundingClientRect();
    const vertical = this.options.direction === "vertical";
    const dividerSize = vertical ? this.divider.offsetWidth : this.divider.offsetHeight;
    const available = (vertical ? rect.width : rect.height) - dividerSize;
    if (available <= 0) return;
    const position = vertical ? event.clientX - rect.left : event.clientY - rect.top;
    this.setRatio((position - dividerSize / 2) / available);
  }

  private endResize(): void {
    if (this.pointerId === null) return;
    const id = this.pointerId;
    this.pointerId = null;
    if (this.divider.hasPointerCapture(id)) this.divider.releasePointerCapture(id);
    this.content.classList.remove("split-preview-resizing");
    this.host.changed(this.options);
  }

  private resizeByKey(event: KeyboardEvent): void {
    const vertical = this.options.direction === "vertical";
    const smaller = vertical ? "ArrowLeft" : "ArrowUp";
    const larger = vertical ? "ArrowRight" : "ArrowDown";
    if (![smaller, larger, "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.1 : 0.02;
    const ratio = event.key === "Home" ? 0.2 : event.key === "End" ? 0.8 : event.key === "Enter" ? 0.5
      : this.options.ratio + (event.key === smaller ? -step : step);
    this.setRatio(ratio, true);
  }

  onunload(): void {
    this.disposed = true;
    this.win.clearTimeout(this.renderTimer);
    this.win.cancelAnimationFrame(this.syncFrame);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.endResize();
    for (const task of this.disabledTasks) task.disabled = false;
    this.disabledTasks.clear();
    this.preview.classList.remove("split-preview-native");
    // Do not restore a saved display value: Obsidian may have changed mode.
    // Only the plugin's class forced visibility; native styles stay untouched.
    if (this.marker.parentNode) this.marker.replaceWith(this.preview);
    this.pane.remove();
    this.divider.remove();
    this.content.classList.remove("split-preview-host", "split-preview-resizing");
    delete this.content.dataset.splitPreviewDirection;
    this.content.style.removeProperty("--split-preview-ratio");
    this.content.style.removeProperty("--split-preview-rest");
  }
}
