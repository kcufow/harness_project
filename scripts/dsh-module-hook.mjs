/**
 * dsh 运行时加载插件时，插件的 peer 依赖（@deepseek-ai/cordis、
 * @deepseek-ai/dsh-tools、@deepseek-ai/schemastery）由宿主 dsh 提供，
 * profile 的 node_modules 里通常只有插件本体。直接 import 安装产物会报
 * ERR_MODULE_NOT_FOUND。
 *
 * 这个 resolve hook 在裸包解析失败时回退到宿主 node_modules，用来在仓库里
 * 复现 dsh 的加载语义，从而验证「tarball 解包产物」本身是否完整可用。
 *
 * - 默认宿主：仓库根 node_modules（npm ci 后即具备，无需安装 dsh）
 * - 覆盖宿主：DSH_RUNTIME_NODE_MODULES=<dsh 安装目录>/node_modules
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeNodeModules = process.env.DSH_RUNTIME_NODE_MODULES
const anchorDir = runtimeNodeModules ? dirname(runtimeNodeModules) : repoRoot
const hostRequire = createRequire(join(anchorDir, 'package.json'))

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('node:') ||
      specifier.startsWith('file:')
    ) {
      throw error
    }
    try {
      return await nextResolve(pathToFileURL(hostRequire.resolve(specifier)).href, context)
    } catch {
      throw error
    }
  }
}
