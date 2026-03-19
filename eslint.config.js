import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['warn', {
                'argsIgnorePattern': '^_|^next|^req|^res|^err',
                'varsIgnorePattern': '^_'
            }],
            'no-console': 'warn',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { 'avoidEscape': true }],
            'indent': ['error', 4],
            'no-constant-condition': 'warn',
            'no-empty': 'warn'
        }
    }
];
