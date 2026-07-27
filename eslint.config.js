import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
