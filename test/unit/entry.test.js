import { test } from "node:test"
import assert from "node:assert/strict"
import root from "../../index.js"
import src from "../../src/index.js"

test("the repo root exposes the plugin for OpenCode's local-directory loader (<dir>/index)", () => {
  assert.equal(root, src)
  assert.equal(root.id, "vibeguard")
  assert.equal(typeof root.setup, "function")
})
