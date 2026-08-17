/**
 * 构建 Client 半体（lib/client.js）——精确复刻 DSH 的 __ModuleLoader__ 格式。
 *
 * 产物结构（对照 dsh-client-runtime 等内置包）：
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *       <esbuild 打包代码，external 的模块走 require()>
 *       return module.exports;
 *     }
 *   });
 *
 * external 列表 = DSH client module table（seed 词表）里的模块：
 *   react / react/jsx-runtime / react-dom / react-dom/client
 *   @deepseek-ai/cordis / @deepseek-ai/dsh-client-ui-slots
 *   @deepseek-ai/dsh-client-web-react / @deepseek-ai/dsh-client-ui-primitives
 *   @deepseek-ai/dsh-client-schema-form
 * 以及 settings-plugins 实际 require 的：@deepseek-ai/dsh-client-runtime/client
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const PKG_ID = pkg.name

const banner = `window.__ModuleLoader__.load({
  id: "${PKG_ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `    return module.exports;
  }
});
`

await build({
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  banner: { js: banner },
  footer: { js: footer },
  // 精确匹配 DSH client module table 可解析的 specifier
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-web-react',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-schema-form',
    '@deepseek-ai/dsh-client-runtime/client',
  ],
  sourcemap: true,
  logLevel: 'info',
})

console.log('lib/client.js 构建完成')
