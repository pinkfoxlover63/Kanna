import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'resources/**', '.opencode/**', 'build/**'] },
  js.configs.recommended,
  {
    // Electron main process: CommonJS + Node globals.
    files: ['src/main/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // Preload bridge: CommonJS but runs in the renderer world.
    files: ['src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Renderer: classic browser scripts, no bundler.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: globals.browser,
    },
  },
  {
    // Scratch/one-off Node scripts at the repo root.
    files: ['*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
];
