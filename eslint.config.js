import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config for the TypeScript ESM sources.
 *
 * The rules describe the style this codebase already has rather than importing an opinionated
 * preset: compact single-line guards (`if (!token) return;`), single quotes, semicolons, two-space
 * indentation, no dangling commas. Anything that would demand a project-wide reformat, or that
 * would fight the deliberate `any` usage on database rows and Telegram payloads, is switched off.
 *
 * `web/` is intentionally out of scope: it is browser-targeted JavaScript bundled by esbuild and is
 * not part of the TypeScript program.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'web/**', 'data/**', 'coverage/**', 'scripts/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      // ---- formatting, matching the existing sources -------------------------------------------
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/indent': ['error', 2, {
        SwitchCase: 1,
        offsetTernaryExpressions: true,
        ignoredNodes: ['TemplateLiteral *']
      }],
      '@stylistic/comma-dangle': ['error', 'never'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-before-function-paren': ['error', {
        anonymous: 'always', named: 'never', asyncArrow: 'always'
      }],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],

      // Single-line guards are the house style; braces are only expected once a body wraps.
      // Advisory rather than blocking: the one place that trips it today is pre-existing and is
      // tracked as a cleanup, not a build breaker.
      curly: ['warn', 'multi-line'],

      // ---- correctness --------------------------------------------------------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Same reasoning as `curly`: worth surfacing, not worth failing an existing file over.
      'no-return-await': 'warn',

      // ---- deliberately relaxed -----------------------------------------------------------------
      // Database rows, Telegram updates and provider payloads are untyped at the boundary and are
      // narrowed by hand; forcing `unknown` here would only add casts.
      '@typescript-eslint/no-explicit-any': 'off',
      // Logger and callback shapes are declared as `{ warn: Function }` throughout.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'
      }]
    }
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      // Vitest assertions frequently need loose shapes and unused destructuring.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off'
    }
  }
);
