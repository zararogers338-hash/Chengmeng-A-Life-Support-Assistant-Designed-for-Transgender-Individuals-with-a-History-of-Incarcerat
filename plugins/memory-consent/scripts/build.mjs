// 把 client/ 里的源码包装成 DSH 客户端 bundle（lib/client.js）。
// 包装格式与 DSH 0.2.2-rc.1 官方客户端包一致：window.__ModuleLoader__.load({ id, factory })，复制自
// plugins/pastel-theme/scripts/build.mjs，只改 modules 顺序与说明。不引入打包器：
// 源码只用浏览器原生 API，不依赖任何第三方模块，React 由宿主通过 require('react') 提供。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// 模块之间的相对 import 只为了让源码能单独作为 ES 模块运行（预览页、单元测试）；
// 打包后所有模块在同一作用域，所以剥掉。其他 import 一律拒绝。
// 注意：构建器只支持顶层 export const/function/let，所以源码里不要写 export class 或
// export async function（用 export const xx = async () => {} 代替）。
const strip = (source) => source
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/[\w-]+\.js'\s*\n/gm, '')
  .replace(/^export\s+(const|function|let)\s/gm, '$1 ')
// 顺序即依赖顺序：后面的模块可以使用前面模块的顶层符号。
const modules = [
  'client/springs.js',
  'client/api.js',
  'client/styles.js',
  'client/dock.js',
  'client/settings.js',
]
const library = (await Promise.all(modules.map((m) => readFile(join(root, m), 'utf8')))).map(strip).join('\n')
const entry = await readFile(join(root, 'client/entry.js'), 'utf8')
const sources = library + entry

if (/^\s*(import|export)\s/m.test(sources)) {
  throw new Error('客户端源码里不能有 import/export 残留，构建器只支持顶层 export const/function/let')
}
// 客户端只允许同源相对路径：源码里不能出现外部地址，也不许用通知和 console 输出用户内容。
if (/https?:\/\//i.test(sources)) throw new Error('客户端源码里不能出现外部地址')
if (/\bNotification\b/.test(sources)) throw new Error('客户端不允许使用 Notification API')
if (/\bconsole\.log\s*\(/.test(sources)) throw new Error('客户端源码里不能有 console.log')
if (/(^|[^\w.$])eval\s*\(/.test(sources)) throw new Error('客户端源码里不能有 eval')

const declared = [...sources.matchAll(/^(?:const|function|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
const duplicate = declared.find((id, i) => declared.indexOf(id) !== i)
if (duplicate) throw new Error(`多个模块重复声明了顶层符号：${duplicate}`)
// 入口必须导出模块加载器要的三样东西，否则宿主会静默跳过这个客户端包。
for (const symbol of ['const name', 'const inject', 'function apply']) {
  if (!entry.includes(symbol)) throw new Error(`入口缺少 ${symbol}`)
}

const indent = (text) => text.split('\n').map((line) => (line ? `\t\t${line}` : line)).join('\n')

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${indent(library)}
${indent(entry)}
\t\texports.name = name;
\t\texports.inject = inject;
\t\texports.apply = apply;
\t\treturn module.exports;
\t}
});
`

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib/client.js'), bundle)
console.log(`built lib/client.js (${bundle.length} bytes)`)
