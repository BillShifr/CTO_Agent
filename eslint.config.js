import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.artifacts/**', 'node_modules/**'] },
  tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { complexity: ['error', 20] },
  },
);
