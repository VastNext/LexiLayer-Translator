# LexiLayer Full Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the current product and its active engineering identifiers from Vast Translator to LexiLayer Translator, with Chinese display name 语层翻译 and short brand name 语层.

**Architecture:** Keep the existing extension behavior, storage schema, message protocol, permissions, translation endpoints, and repository location unchanged. Update user-facing strings and explicit product/build identifiers in place, then validate the generated Manifest and all automated tests. Rename only current files and identifiers that explicitly encode the old product name; preserve historical Git content and unrelated domain references.

**Tech Stack:** TypeScript, React, Vite, Chrome Manifest V3, JSON locale files, Vitest, Playwright, npm.

---

### Task 1: Inventory rename targets and update version

**Files:**
- Modify: `package.json:2-4`
- Modify: `package-lock.json` root package metadata
- Test: `tests/build/production-build.test.ts`

**Step 1: Add the expected package identity to the build contract**

Update the existing build test to assert the new package name and the incremented patch version rather than relying only on truthy metadata.

**Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/build/production-build.test.ts`

Expected: FAIL because the package metadata still uses `vast-translator-chrome-plugin` and the old version.

**Step 3: Update package metadata**

Use `npm version patch --no-git-tag-version` after changing the package name to `lexilayer-translator-chrome-plugin`, so `package-lock.json` stays synchronized. Keep the current version source-of-truth behavior intact.

**Step 4: Run the focused test to verify it passes**

Run: `npx vitest run tests/build/production-build.test.ts`

Expected: PASS.

### Task 2: Rename extension localization and UI branding

**Files:**
- Modify: `public/_locales/zh_CN/messages.json`
- Modify: `public/_locales/en/messages.json`
- Modify: `popup.html:6`
- Modify: `options.html:6`
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/options/OptionsApp.tsx`
- Modify: `src/BrandMark.tsx`
- Modify: `src/content/selection-view.ts`
- Modify: `tests/e2e/extension.spec.ts`
- Modify: `tests/ui/visual-contract.test.ts`

**Step 1: Update localization and static titles**

Set `extensionName` to `语层翻译` for `zh_CN` and `LexiLayer Translator` for `en`. Set page titles and visible short brand labels to `语层` or `LexiLayer` according to the active locale or existing localized rendering pattern. Update SVG accessibility labels and selection-panel labels without changing behavior.

**Step 2: Update visible-brand test expectations**

Change exact text assertions from `Vast Translator` to the new localized product or short brand text. Add assertions for the Chinese and English localized extension names where the existing build tests load locale files.

**Step 3: Run focused UI and build tests**

Run: `npx vitest run tests/ui/visual-contract.test.ts tests/build/manifest.test.ts tests/build/production-build.test.ts`

Expected: PASS.

### Task 3: Rename explicit engineering identifiers

**Files:**
- Modify: `vite.config.ts:17,42`
- Modify: `src/manifest.ts` only if an explicit product identifier is present
- Modify: `src/BrandMark.tsx` accessibility and component-adjacent labels
- Rename: any current file whose name explicitly contains `vast-translator` after inventory confirms it is active
- Modify: tests covering generated names and bundle content

**Step 1: Update Vite and bundle identifiers**

Rename the Vite plugin name and the classic content-script IIFE name to `emit-lexilayer-extension-manifest`, `build-classic-lexilayer-content-script`, and `LexiLayerContent`. Do not alter emitted file names such as `content.js`, `popup.js`, or `background.js`, because they are Manifest entry points.

**Step 2: Search for remaining active engineering names**

Run: `rg -n -i "vasttranslator|vast-translator|vast translator" --glob '!docs/plans/2026-08-27-*' --glob '!*.lock'`

Classify each result as user-facing, active engineering metadata, design-preview content, or historical context. Update the first three categories; retain only explicitly documented historical references.

**Step 3: Run type checking**

Run: `npm run typecheck`

Expected: PASS with no identifier-related TypeScript errors.

### Task 4: Synchronize documentation and design previews

**Files:**
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `docs/chrome-web-store/README.md`
- Modify: `docs/chrome-web-store/store-listing.md`
- Modify: `docs/chrome-web-store/privacy-and-review.md`
- Modify: `docs/chrome-web-store/release-checklist.md`
- Modify: `.github/workflows/release.yml`
- Modify: `design-previews/index.html`
- Modify: `design-previews/shared.js`
- Modify: `design-previews/shared.css`
- Modify: `design-previews/expert-shared.js`
- Modify: `design-previews/expert-settings-refinement.html`

**Step 1: Replace current product references**

Use `语层翻译` and `LexiLayer Translator` for full product references, and `语层` and `LexiLayer` for short interface references. Update design-preview Logo class names and embedded markup from the old route/horizon/beacon mark to the current constellation mark where those previews are intended to represent the current product.

**Step 2: Preserve historical and external context**

Do not rewrite GitHub organization names, old plan-history statements, or references whose purpose is to describe project history. Keep the repository URL `VastNext/LexiLayer-Translator` unchanged.

**Step 3: Search for stale active documentation**

Run: `rg -n -i "Vast Translator|VastNext|vast-translator" README.md PRIVACY.md docs design-previews .github`

Expected: only approved organization/repository references or historical context remain.

### Task 5: Validate the complete renamed extension

**Files:**
- Test: `tests/build/manifest.test.ts`
- Test: `tests/build/production-build.test.ts`
- Test: `tests/e2e/extension.spec.ts`
- Test: all existing test suites

**Step 1: Run unit and integration tests**

Run: `npm test`

Expected: PASS.

**Step 2: Run type checking**

Run: `npm run typecheck`

Expected: PASS.

**Step 3: Build the extension**

Run: `npm run build`

Expected: PASS; generated `dist/manifest.json` uses the locale message key, generated icons remain present, and bundle identifiers contain no stale active product name.

**Step 4: Run browser tests**

Run: `npm run e2e`

Expected: PASS for non-network extension flows.

**Step 5: Review the final diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors; only rename-related files and the new plan/design documents are changed. Do not commit unless explicitly requested.
