import test from "node:test";
import assert from "node:assert/strict";
import { isStampOnlyChange } from "./stampOnlyUpdate.mjs";

test("a change to only the build stamp is not a code update", () => {
  assert.equal(isStampOnlyChange(["lib/precious-build-stamp.json"]), true);
  assert.equal(isStampOnlyChange([]), true);
});

test("any other file counts as a real code update", () => {
  assert.equal(isStampOnlyChange(["lib/precious-build-stamp.json", "mias/index.js"]), false);
  assert.equal(isStampOnlyChange(["server.js"]), false);
  assert.equal(isStampOnlyChange(undefined), false);
});
