import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';

import { manifest } from './src/manifest.ts';
import { rule as googleSearchRule } from './src/rules/sites/google-search.ts';
import { rule as bingSearchRule } from './src/rules/sites/bing-search.ts';
import { rule as githubRule } from './src/rules/sites/github.ts';
import { rule as youtubeRule } from './src/rules/sites/youtube.ts';
import { rule as redditRule } from './src/rules/sites/reddit.ts';
import { rule as xRule } from './src/rules/sites/x.ts';
import { rule as stackoverflowRule } from './src/rules/sites/stackoverflow.ts';
import { rule as substackRule } from './src/rules/sites/substack.ts';

function emitManifest(): Plugin {
  return {
    name: 'emit-extension-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      });
      for (const rule of [googleSearchRule, bingSearchRule, githubRule, youtubeRule, redditRule, xRule, stackoverflowRule, substackRule]) {
        this.emitFile({ type: 'asset', fileName: `rules/${rule.id}.json`, source: JSON.stringify(rule) });
      }
    },
  };
}

function buildClassicContentScript(): Plugin {
  return {
    name: 'build-classic-content-script',
    async closeBundle() {
      await build({
        configFile: false,
        build: {
          emptyOutDir: false,
          lib: {
            entry: resolve(import.meta.dirname, 'src/content/index.ts'),
            formats: ['iife'],
            name: 'VastTranslatorContent',
            fileName: () => 'content.js',
          },
          outDir: resolve(import.meta.dirname, 'dist'),
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), emitManifest(), buildClassicContentScript()],
  build: {
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
        popup: resolve(import.meta.dirname, 'popup.html'),
        options: resolve(import.meta.dirname, 'options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
