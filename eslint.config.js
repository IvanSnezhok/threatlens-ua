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
    // `.claude/worktrees/**` holds full checkouts of this same repository. Without it, every
    // TypeScript file exists several times over and the parser cannot decide which tsconfig root
    // it belongs to, which fails the whole run rather than any one file.
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'web/**', 'data/**', 'coverage/**', 'scripts/**', '.claude/**']
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
  },
  {
    /**
     * The deployment runner's isolation, expressed as a rule rather than as a directory boundary.
     *
     * `src/deployer/**` compiles into a SEPARATE container that holds `/var/run/docker.sock`
     * (`deploy/Dockerfile`, service `deployer`). It lives in the ordinary source tree so that the
     * project's typecheck, lint and unit tests cover the code that can restart production — but it
     * must never grow a dependency on the application it deploys. One `import { pool }
     * from '../db/pool.js'` and the runner would carry `src/config.ts`, which expects the app's whole
     * `.env`; one `import … from 'fastify'` and the socket-holding process acquires a plugin
     * ecosystem nobody here has read.
     *
     * The allow-list is `node:*`, `pg`, `zod` and this package's own files. Everything else,
     * including any `../` escape, is an error. Widening it is a deliberate, reviewable act.
     */
    files: ['src/deployer/**/*.ts'],
    // The tests are not part of the image — `deploy/Dockerfile` copies only compiled `dist/deployer`
    // and `tsconfig.json` excludes `*.test.ts` from the build — so they may import `vitest`. The
    // structural half of this rule in `compose-contract.test.ts` skips them for the same reason.
    ignores: ['src/deployer/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          // A negative lookahead rather than a gitignore-style negated group: `!./*` does not
          // un-match a specifier that begins with `./`, so the group form would forbid this
          // package's own files. Anything that is not a node builtin, `pg`, `zod` or a sibling in
          // this directory matches — including every `../` escape.
          regex: '^(?!node:|pg$|zod$|\\./[^/]+$)',
          message: 'src/deployer/** may import only node:*, pg, zod and its own files: it builds into the container that holds the Docker socket.'
        }]
      }]
    }
  }
);
