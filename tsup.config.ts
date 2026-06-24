import { defineConfig } from 'tsup'

// 单文件 bundle 配置：把整个 src/ 打包到 dist/index.js
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  minify: false,
  sourcemap: true,
  // CLI 入口必须加 shebang
  banner: {
    js: '#!/usr/bin/env node',
  },
  // 不内联依赖：避免 CJS/ESM 互转问题，依赖留在 node_modules
  splitting: false,
  shims: false,
})
