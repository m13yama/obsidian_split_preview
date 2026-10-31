import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OPTIONS, loadOptions, loadSettings } from "../src/options.ts";

test("missing or corrupt persisted settings use usable defaults", () => {
  for (const value of [null, undefined, false, "invalid", {}]) {
    assert.deepEqual(loadOptions(value), DEFAULT_OPTIONS);
  }
});

test("valid settings survive reload, including disabled scroll following", () => {
  const options = { direction: "horizontal", ratio: 0.72, syncScroll: false, refreshDelay: 350 };
  assert.deepEqual(loadOptions(options), options);
});

test("persisted sizes cannot hide either pane or schedule an invalid timer", () => {
  assert.deepEqual(loadOptions({ ratio: 2, refreshDelay: -3, direction: "diagonal", syncScroll: "false" }), {
    direction: "vertical", ratio: 0.8, syncScroll: true, refreshDelay: 0,
  });
  assert.equal(loadOptions({ ratio: -1, refreshDelay: 9000 }).ratio, 0.2);
  assert.equal(loadOptions({ refreshDelay: 9000 }).refreshDelay, 1000);
  assert.deepEqual(loadOptions({ ratio: NaN, refreshDelay: Infinity }), DEFAULT_OPTIONS);
});

test("global preview visibility survives serialization for both open and closed states", () => {
  for (const previewOpen of [true, false]) {
    const settings = { ...DEFAULT_OPTIONS, direction: "horizontal", previewOpen };
    assert.deepEqual(loadSettings(JSON.parse(JSON.stringify(settings))), settings);
  }
});

test("older settings migrate with the preview closed and retain existing preferences", () => {
  const oldSettings = { direction: "horizontal", ratio: 0.7, syncScroll: false, refreshDelay: 300 };
  assert.deepEqual(loadSettings(oldSettings), { ...oldSettings, previewOpen: false });
  for (const value of [null, undefined, false, "invalid", { previewOpen: "true" }]) {
    assert.deepEqual(loadSettings(value), { ...DEFAULT_OPTIONS, previewOpen: false });
  }
});
