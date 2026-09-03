import { defineConfig } from 'tsdown'

/** Build the browser half as a DSH client-plugin module. */
export default defineConfig({
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: ['react'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-approve-for-me", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
