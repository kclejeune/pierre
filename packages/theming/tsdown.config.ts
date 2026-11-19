import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig[] = defineConfig([
  {
    entry: ['src/**/*.ts', 'src/**/*.tsx'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: {
      sourcemap: true,
      generator: 'tsgo',
    },
    unbundle: true,
    platform: 'neutral',
  },
]);

export default config;
