export type Direction = "vertical" | "horizontal";

export interface Options {
  direction: Direction;
  ratio: number;
  syncScroll: boolean;
  refreshDelay: number;
}

export interface Settings extends Options {
  previewOpen: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  direction: "vertical",
  ratio: 0.5,
  syncScroll: true,
  refreshDelay: 150,
};

export function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.5;
}

export function loadOptions(value: unknown): Options {
  const data = value && typeof value === "object" ? value as Partial<Options> : {};
  return {
    direction: data.direction === "horizontal" ? "horizontal" : "vertical",
    ratio: clampRatio(typeof data.ratio === "number" ? data.ratio : 0.5),
    syncScroll: typeof data.syncScroll === "boolean" ? data.syncScroll : true,
    refreshDelay: typeof data.refreshDelay === "number" && Number.isFinite(data.refreshDelay)
      ? Math.max(0, Math.min(1000, data.refreshDelay)) : 150,
  };
}

export function loadSettings(value: unknown): Settings {
  const data = value && typeof value === "object" ? value as Partial<Settings> : {};
  return {
    ...loadOptions(value),
    previewOpen: typeof data.previewOpen === "boolean" ? data.previewOpen : false,
  };
}
