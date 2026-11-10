// 把 src/ 里的源码包装成 DSH 客户端 bundle（lib/client.js）。
// 包装格式与 DSH 0.2.2-rc.1 官方客户端包一致：window.__ModuleLoader__.load({ id, factory })。
// 不引入打包器：源码只用浏览器原生 API，不依赖任何第三方模块。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// 模块之间的相对 import 只为了让源码能单独作为 ES 模块运行（预览页、单元测试）；
// 打包后所有模块在同一作用域，所以剥掉。其他 import 一律拒绝。
const strip = (source) => source
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/[\w-]+\.js'\s*\n/gm, '')
  .replace(/^export\s+(const|function|let)\s/gm, '$1 ')
// 顺序即依赖顺序：后面的模块可以使用前面模块的顶层符号。
const modules = ['src/springs.js', 'src/config.js', 'src/schedule.js', 'src/startup.js']
const library = (await Promise.all(modules.map((m) => readFile(join(root, m), 'utf8')))).map(strip).join('\n')
const entry = await readFile(join(root, 'src/client-entry.js'), 'utf8')

if (/^\s*(import|export)\s/m.test(library + entry)) {
  throw new Error('客户端源码里不能有 import/export 残留，构建器只支持顶层 export const/function')
}
const declared = [...(library + entry).matchAll(/^(?:const|function|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
const duplicate = declared.find((id, i) => declared.indexOf(id) !== i)
if (duplicate) throw new Error(`多个模块重复声明了顶层符号：${duplicate}`)

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
