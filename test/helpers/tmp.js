import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function tmpdir(t) {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "vg-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function withHome(t, dir) {
  const previous = process.env.HOME
  process.env.HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  })
}
