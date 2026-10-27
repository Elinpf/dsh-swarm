// 扁平 ESLint 配置（ESLint 10）。只做基础推荐规则 + TS 推荐规则，
// 保持轻量，避免在骨架阶段引入过多规则噪音。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // 构建产物、依赖、隔离环境一律不检查
    ignores: ['**/lib/**', '**/node_modules/**', '.runtime/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 测试里用 any 搭最小 mock，属于有意为之
    files: ['**/*.spec.ts', '**/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // 约定：下划线前缀表示「有意未使用」（占位参数、仅为类型增强的 import）
    // .mjs 脚本同样适用该约定（@typescript-eslint/no-unused-vars 已覆盖 .mjs）
    files: ['**/*.ts', '**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node 环境脚本（.mjs / scripts/）需要 console、process 等全局
    files: ['**/*.mjs', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        globalThis: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
  },
)
