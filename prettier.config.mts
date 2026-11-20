import type { Config } from 'prettier';

const config: Config = {
  trailingComma: 'all',
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  jsxSingleQuote: true,
  bracketSameLine: false,
  quoteProps: 'preserve',
  arrowParens: 'always',
  bracketSpacing: true,
  embeddedLanguageFormatting: 'auto',
  endOfLine: 'lf',
  htmlWhitespaceSensitivity: 'css',
  insertPragma: false,
  plugins: [],
  printWidth: 80,
  proseWrap: 'always',
  requirePragma: false,
  useTabs: false,
  vueIndentScriptAndStyle: false,
  singleAttributePerLine: true,
  experimentalOperatorPosition: 'start',
  overrides: [
    {
      files: ['tsconfig*.json'],
      options: {
        parser: 'jsonc',
      },
    },
  ],
};

export default config;
