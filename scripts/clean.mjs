#!/usr/bin/env node
/** 删除所有 workspace 包的构建产物（lib/）。根目录 .gitignore 已忽略 lib/。 */
import { rm } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packages = join(root, 'packages')

async function main() {
  let names = []
  try {
    names = await readdir(packages)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(packages, name)
    const info = await stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) continue
    await rm(join(dir, 'lib'), { recursive: true, force: true })
    process.stdout.write(`cleaned packages/${name}/lib\n`)
  }
}

await main()
