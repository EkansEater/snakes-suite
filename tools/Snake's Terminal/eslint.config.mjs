import globals from 'globals';

export default [
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }], 'no-dupe-keys': 'error', 'no-unreachable': 'error' },
  },
  {
    files: ['src/main/**/*.js', 'build.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  { files: ['build.mjs'], languageOptions: { sourceType: 'module' } },
];
