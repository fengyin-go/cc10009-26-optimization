/** 测试打包器：把 @/ 别名解析到 src/，输出 ESM 到缓存目录后交给 Node 运行。 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, 'node_modules/.cache')
mkdirSync(outDir, { recursive: true })

const extensions = ['.ts', '.mjs', '.js', '.json']

function resolveWithExtensions(pathWithoutExt) {
  if (existsSync(pathWithoutExt)) {
    return pathWithoutExt
  }
  for (const ext of extensions) {
    const candidate = `${pathWithoutExt}${ext}`
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return pathWithoutExt
}

await build({
  entryPoints: [resolve(root, 'scripts/retry-engine.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(outDir, 'retry-engine.test.mjs'),
  logLevel: 'info',
  plugins: [
    {
      name: 'at-alias',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@\// }, (args) => ({
          path: resolveWithExtensions(resolve(root, 'src', args.path.slice(2))),
        }))
      },
    },
  ],
})
