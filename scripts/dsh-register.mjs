/** 注册 dsh-module-hook.mjs 为 ESM resolve hook。 */
import { register } from 'node:module'

register('./dsh-module-hook.mjs', import.meta.url)
