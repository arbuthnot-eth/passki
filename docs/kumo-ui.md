# Kumo UI -- Comprehensive Reference

> Cloudflare's React component library. v1.9.0 | MIT License | [kumo-ui.com](https://kumo-ui.com) | [GitHub](https://github.com/cloudflare/kumo)

---

## Table of Contents

1. [Overview and Design Philosophy](#overview-and-design-philosophy)
2. [Installation](#installation)
3. [Architecture and Structure](#architecture-and-structure)
4. [Design Tokens and Theming](#design-tokens-and-theming)
5. [Styling Conventions](#styling-conventions)
6. [Components Reference](#components-reference)
   - [Badge](#badge)
   - [Banner](#banner)
   - [Breadcrumbs](#breadcrumbs)
   - [Button](#button)
   - [Checkbox](#checkbox)
   - [Collapsible](#collapsible)
   - [Combobox](#combobox)
   - [CommandPalette](#commandpalette)
   - [DatePicker](#datepicker)
   - [DateRangePicker](#daterangepicker)
   - [Dialog](#dialog)
   - [DropdownMenu](#dropdownmenu)
   - [Grid](#grid)
   - [Input](#input)
   - [Label](#label)
   - [MenuBar](#menubar)
   - [Meter](#meter)
   - [Pagination](#pagination)
   - [Popover](#popover)
   - [Radio](#radio)
   - [Select](#select)
   - [Surface](#surface)
   - [Switch](#switch)
   - [Table](#table)
   - [Tabs](#tabs)
   - [Text](#text)
   - [Toast](#toast)
   - [Tooltip](#tooltip)
7. [Accessibility](#accessibility)
8. [Adapting for Vanilla JS/CSS](#adapting-for-vanilla-jscss)

---

## Overview and Design Philosophy

Kumo is Cloudflare's design system and component library for building modern web applications. Core principles:

- **Accessibility first** -- Built on [Base UI](https://base-ui.com/) primitives. Keyboard navigation, focus management, and ARIA attributes are handled automatically.
- **Semantic token system** -- All colors use semantic tokens (`bg-kumo-base`, `text-kumo-default`, `border-kumo-line`) that auto-adapt to light/dark mode via CSS `light-dark()`. No `dark:` variant needed.
- **Tree-shakeable** -- ESM-only, per-component granular imports available.
- **Compound components** -- Complex components (Dialog, DropdownMenu, CommandPalette, Table) use dot-notation sub-components for composition.
- **Tailwind v4** -- Styling uses Tailwind v4 utility classes composed via the `cn()` utility function.

**Tech stack:** TypeScript (79.7%), Astro docs site, Vite library-mode build, pnpm monorepo, Node 24+.

---

## Installation

### Package

```bash
pnpm add @cloudflare/kumo
```

### Peer Dependencies

```bash
pnpm add react react-dom @phosphor-icons/react
```

### Import Styles

```typescript
import "@cloudflare/kumo/styles";
```

### Import Components

```typescript
// Barrel import (all components)
import { Button, Input, Dialog } from "@cloudflare/kumo";

// Granular import (tree-shaking friendly)
import { Button } from "@cloudflare/kumo/components/button";

// Base UI primitives access
import { Popover } from "@cloudflare/kumo/primitives/popover";
```

### CLI Tools

```bash
npx @cloudflare/kumo ls          # List all components
npx @cloudflare/kumo doc Button  # Get specific component docs
npx @cloudflare/kumo docs        # Generate all documentation
npx @cloudflare/kumo add         # Install blocks into your project
```

### Development (contributing)

```bash
pnpm install
pnpm dev           # Docs site at localhost:4321
pnpm --filter @cloudflare/kumo test
pnpm --filter @cloudflare/kumo new-component   # Scaffold new component
```

---

## Architecture and Structure

```
kumo/
  packages/
    kumo/                         # Component library
      src/
        components/               # 35 UI components
        blocks/                   # Installable blocks (via CLI, NOT library exports)
        primitives/               # AUTO-GENERATED Base UI re-exports (37 files)
        catalog/                  # JSON-UI rendering runtime
        command-line/             # CLI: ls, doc, add, blocks, init, migrate
        styles/                   # CSS: kumo-binding.css + theme files (AUTO-GENERATED)
        utils/                    # cn(), safeRandomId, LinkProvider
      ai/                        # AUTO-GENERATED: component-registry.{json,md}, schemas.ts
      scripts/
        theme-generator/          # Theme CSS codegen from config.ts
        component-registry/       # Registry codegen pipeline
    kumo-docs-astro/              # Astro docs site
    kumo-figma/                   # Figma plugin
```

### Build pipeline

```
kumo-docs-astro demos -> dist/demo-metadata.json
                              |
kumo codegen:registry -> ai/component-registry.{json,md} + ai/schemas.ts
                              |
kumo-figma build:data -> generated/*.json -> esbuild -> code.js
```

### Component file pattern

Each component lives at `src/components/{name}/{name}.tsx` and must:

1. Export `KUMO_{NAME}_VARIANTS` + `KUMO_{NAME}_DEFAULT_VARIANTS`
2. Use `forwardRef` when wrapping DOM elements
3. Set `.displayName` on the forwardRef component
4. Use `cn()` for all className composition
5. Use Base UI primitives for interactive behavior

---

## Design Tokens and Theming

All tokens are CSS custom properties generated from `scripts/theme-generator/config.ts`. They auto-adapt to light/dark mode via CSS `light-dark()`.

### Text Color Tokens

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `text-kumo-default` | neutral-900 | neutral-100 | Primary text |
| `text-kumo-inverse` | neutral-100 | neutral-900 | Inverted text |
| `text-kumo-strong` | neutral-600 | neutral-400 | Emphasized text |
| `text-kumo-subtle` | neutral-500 | neutral-50 | De-emphasized text |
| `text-kumo-inactive` | neutral-400 | neutral-600 | Disabled state text |
| `text-kumo-brand` | #f6821f | #f6821f | Cloudflare orange (fixed) |
| `text-kumo-link` | blue-800 | blue-400 | Interactive links |
| `text-kumo-success` | -- | -- | Success state |
| `text-kumo-danger` | -- | -- | Error/danger state |
| `text-kumo-warning` | -- | -- | Warning state |
| `text-kumo-info` | -- | -- | Informational state |

### Background Tokens

| Token | Purpose |
|-------|---------|
| `bg-kumo-base` | Page background (white light / black dark) |
| `bg-kumo-elevated` | Raised surface (cards, panels) |
| `bg-kumo-recessed` | Sunken surface |
| `bg-kumo-overlay` | Modal/dropdown backdrop |
| `bg-kumo-tint` | Subtle hover background |
| `bg-kumo-control` | Input/button background |
| `bg-kumo-interact` | Interactive element hover |
| `bg-kumo-fill` | Filled areas |
| `bg-kumo-fill-hover` | Filled area hover |
| `bg-kumo-contrast` | High-contrast background |
| `bg-kumo-brand` | Cloudflare orange |
| `bg-kumo-brand-hover` | Orange hover |
| `bg-kumo-info` / `bg-kumo-info-tint` | Info state |
| `bg-kumo-warning` / `bg-kumo-warning-tint` | Warning state |
| `bg-kumo-danger` / `bg-kumo-danger-tint` | Danger state |
| `bg-kumo-success` / `bg-kumo-success-tint` | Success state |

### Border / Ring Tokens

| Token | Purpose |
|-------|---------|
| `border-kumo-line` | Standard borders |
| `border-kumo-fill` | Filled borders |
| `border-kumo-brand` | Brand-colored border |
| `border-kumo-info` / `border-kumo-warning` / `border-kumo-danger` | State borders |
| `ring-kumo-line` | Default focus ring |
| `ring-kumo-ring` | Active focus ring |
| `ring-kumo-contrast` | High-contrast ring |
| `ring-kumo-danger` | Error focus ring |

### Surface Hierarchy

Surfaces layer: `bg-kumo-base` (level 0) -> `bg-kumo-elevated` (level 1) -> `bg-kumo-recessed` (level 2)

### Typography Scale

| Size | Value |
|------|-------|
| `xs` | 12px |
| `sm` | 13px |
| `base` | 14px |
| `lg` | 16px |

Line heights are computed via formulas (e.g., `calc(1 / 0.75)` for xs).

### Themes

Two themes: **kumo** (default) and **fedramp** (overrides for base, ring colors).

Activated via `data-mode="light"|"dark"` + `data-theme="fedramp"` on a parent element.

---

## Styling Conventions

### Critical Rules

- **ONLY semantic tokens**: `bg-kumo-base`, `text-kumo-default`, `border-kumo-line`, `ring-kumo-ring`
- **NEVER raw Tailwind colors**: `bg-blue-500`, `text-gray-900` -- these fail lint
- **NEVER use `dark:` variant**: Dark mode is automatic via `light-dark()` in CSS custom properties
- **Allowed exceptions**: `bg-white`, `bg-black`, `text-white`, `text-black`, `transparent`
- **`cn()` utility**: Always compose classNames via `cn("base", conditional && "extra", className)`

### Anti-Patterns

| Do NOT | Do Instead |
|--------|-----------|
| `bg-blue-500`, `text-gray-*` | `bg-kumo-brand`, `text-kumo-default` |
| `dark:bg-black` | Remove `dark:` prefix; tokens auto-adapt |
| Dynamic Tailwind class construction | Use static class strings |

---

## Components Reference

---

### Badge

Small status label for categorization or highlighting.

**Import:** `import { Badge } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"primary" \| "secondary" \| "destructive" \| "success" \| "outline" \| "beta"` | `"primary"` |
| `className` | `string` | -- |
| `children` | `ReactNode` | -- |

**Variant descriptions:**
- `primary` -- High-emphasis badge for important labels
- `secondary` -- Subtle badge for secondary information
- `destructive` -- Error or danger state indicator
- `success` -- Success or positive state indicator
- `outline` -- Bordered badge with transparent background
- `beta` -- Dashed-border badge for beta/experimental features

**Tokens used:** `bg-kumo-contrast`, `bg-kumo-danger`, `bg-kumo-fill`, `bg-kumo-success`, `border-kumo-brand`, `border-kumo-fill`, `text-kumo-default`, `text-kumo-inverse`, `text-kumo-link`

**Examples:**

```tsx
<div className="flex flex-wrap items-center gap-2">
  <Badge variant="primary">Primary</Badge>
  <Badge variant="secondary">Secondary</Badge>
  <Badge variant="destructive">Destructive</Badge>
  <Badge variant="success">Success</Badge>
  <Badge variant="outline">Outline</Badge>
  <Badge variant="beta">Beta</Badge>
</div>
```

```tsx
<p className="flex items-center gap-2">
  Workers
  <Badge variant="beta">Beta</Badge>
</p>
```

---

### Banner

Full-width message bar for informational, warning, or error notices.

**Import:** `import { Banner } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `icon` | `ReactNode` | -- |
| `title` | `string` | -- |
| `description` | `ReactNode` | -- |
| `variant` | `"default" \| "alert" \| "error"` | `"default"` |
| `className` | `string` | -- |
| `children` | `ReactNode` | -- |

**Variant descriptions:**
- `default` -- Informational banner (blue) for general messages
- `alert` -- Warning banner (yellow) for cautionary messages
- `error` -- Error banner (red) for critical issues

**Tokens used:** `bg-kumo-danger`, `bg-kumo-danger-tint`, `bg-kumo-info`, `bg-kumo-info-tint`, `bg-kumo-warning`, `bg-kumo-warning-tint`, `border-kumo-danger`, `border-kumo-info`, `border-kumo-warning`, `text-kumo-danger`, `text-kumo-info`, `text-kumo-warning`

**Examples:**

```tsx
<Banner
  icon={<Info weight="fill" />}
  title="Update available"
  description="A new version is ready to install."
/>

<Banner
  icon={<Warning weight="fill" />}
  variant="alert"
  title="Session expiring"
  description="Your session will expire in 5 minutes."
/>

<Banner
  icon={<WarningCircle weight="fill" />}
  variant="error"
  title="Save failed"
  description="We couldn't save your changes. Please try again."
/>

{/* Simple children usage */}
<Banner icon={<Info />}>This is a simple banner using children.</Banner>

{/* Custom rich content in description */}
<Banner
  icon={<Info weight="fill" />}
  title="Custom content supported"
  description={
    <Text DANGEROUS_className="text-inherit">
      This banner supports <strong>custom content</strong> with Text.
    </Text>
  }
/>
```

---

### Breadcrumbs

Navigation breadcrumb trail.

**Import:** `import { Breadcrumbs } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `size` | `"sm" \| "base"` | `"base"` |
| `children` | `ReactNode` | -- |
| `className` | `string` | -- |

**Sub-components:**

| Sub-component | Props |
|---------------|-------|
| `Breadcrumbs.Link` | `href` (required), `icon` |
| `Breadcrumbs.Current` | `loading`, `icon` |
| `Breadcrumbs.Separator` | -- |
| `Breadcrumbs.Clipboard` | `text` (required) |

**Tokens used:** `text-kumo-inactive`, `text-kumo-subtle`, `text-kumo-success`

**Examples:**

```tsx
<Breadcrumbs>
  <Breadcrumbs.Link href="#">Home</Breadcrumbs.Link>
  <Breadcrumbs.Separator />
  <Breadcrumbs.Link href="#">Docs</Breadcrumbs.Link>
  <Breadcrumbs.Separator />
  <Breadcrumbs.Current>Breadcrumbs</Breadcrumbs.Current>
</Breadcrumbs>

{/* With icons */}
<Breadcrumbs>
  <Breadcrumbs.Link href="#" icon={<House size={16} />}>Home</Breadcrumbs.Link>
  <Breadcrumbs.Separator />
  <Breadcrumbs.Link href="#">Projects</Breadcrumbs.Link>
  <Breadcrumbs.Separator />
  <Breadcrumbs.Current>Current Project</Breadcrumbs.Current>
</Breadcrumbs>

{/* With clipboard */}
<Breadcrumbs>
  <Breadcrumbs.Link href="#">Home</Breadcrumbs.Link>
  <Breadcrumbs.Separator />
  <Breadcrumbs.Current>Breadcrumbs</Breadcrumbs.Current>
  <Breadcrumbs.Clipboard text="#" />
</Breadcrumbs>
```

---

### Button

Primary action trigger with multiple variants, sizes, shapes, icons, and loading state.

**Import:** `import { Button } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"primary" \| "secondary" \| "ghost" \| "destructive" \| "secondary-destructive" \| "outline"` | `"secondary"` |
| `shape` | `"base" \| "square" \| "circle"` | `"base"` |
| `size` | `"xs" \| "sm" \| "base" \| "lg"` | `"base"` |
| `icon` | `ReactNode` | -- |
| `loading` | `boolean` | -- |
| `disabled` | `boolean` | -- |
| `children` | `ReactNode` | -- |
| `className` | `string` | -- |
| `type` | `"submit" \| "reset" \| "button"` | -- |

**Variant state classes:**
- `primary`: hover `bg-kumo-brand-hover`, focus `bg-kumo-brand-hover`, disabled `bg-kumo-brand/50`
- `secondary`: hover `bg-kumo-control`, disabled `bg-kumo-control/50`, open `bg-kumo-control`
- `ghost`: hover `bg-kumo-tint`
- `destructive`: hover `bg-kumo-danger/70`
- `secondary-destructive`: hover `bg-kumo-control`, disabled `bg-kumo-control/50`

**Tokens used:** `bg-kumo-base`, `bg-kumo-brand`, `bg-kumo-brand-hover`, `bg-kumo-control`, `bg-kumo-danger`, `bg-kumo-tint`, `ring-kumo-line`, `ring-kumo-ring`, `text-kumo-danger`, `text-kumo-default`, `text-kumo-subtle`

**Examples:**

```tsx
{/* Basic */}
<Button variant="primary">Primary</Button>
<Button variant="secondary">Secondary</Button>

{/* With icon */}
<Button variant="secondary" icon={PlusIcon}>Create Worker</Button>

{/* Icon-only (requires aria-label) */}
<Button variant="secondary" shape="square" icon={PlusIcon} aria-label="Add item" />
<Button variant="secondary" shape="circle" icon={PlusIcon} aria-label="Add item" />

{/* Loading */}
<Button variant="primary" loading>Loading...</Button>

{/* Sizes */}
<Button size="xs" variant="secondary">Extra Small</Button>
<Button size="sm" variant="secondary">Small</Button>
<Button size="base" variant="secondary">Base</Button>
<Button size="lg" variant="secondary">Large</Button>
```

---

### Checkbox

Toggle control with checked, unchecked, and indeterminate states.

**Import:** `import { Checkbox } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"default" \| "error"` | `"default"` |
| `label` | `ReactNode` | -- |
| `labelTooltip` | `ReactNode` | -- |
| `controlFirst` | `boolean` | `true` |
| `checked` | `boolean` | -- |
| `indeterminate` | `boolean` | -- |
| `disabled` | `boolean` | -- |
| `name` | `string` | -- |
| `required` | `boolean` | -- |
| `className` | `string` | -- |
| `onValueChange` | `(checked: boolean) => void` | -- |

**Styling details:**
- Dimensions: `h-4 w-4`, border radius: `rounded-sm`
- Base: `bg-kumo-base`, `ring-kumo-line`
- Checked: `bg-kumo-contrast`, `text-kumo-inverse`
- Error: `ring-kumo-danger`
- Disabled: `opacity-50`, `cursor-not-allowed`

**Sub-components:**

| Sub-component | Props |
|---------------|-------|
| `Checkbox.Item` | -- |
| `Checkbox.Group` | `legend` (required), `children` (required), `error`, `description`, `value`, `allValues`, `disabled`, `controlFirst`, `className` |

**Examples:**

```tsx
{/* Basic */}
<Checkbox label="Accept terms" checked={checked} onCheckedChange={setChecked} />

{/* Indeterminate */}
<Checkbox label="Select all" indeterminate={indeterminate} onCheckedChange={setIndeterminate} />

{/* Label after checkbox */}
<Checkbox label="Remember me" controlFirst={false} checked={checked} onCheckedChange={setChecked} />

{/* Group */}
<Checkbox.Group legend="Preferences" error="Select at least one">
  <Checkbox label="Option A" />
  <Checkbox label="Option B" />
</Checkbox.Group>
```

**Keyboard:** Space toggles, Tab navigates. Group uses `<fieldset>`/`<legend>` for screen readers.

---

### Collapsible

Vertically stacked interactive headings that each reveal a section of content (accordion pattern).

**Import:** `import { Collapsible } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `label` | `string` | **required** |
| `open` | `boolean` | -- |
| `onOpenChange` | `(open: boolean) => void` | -- |
| `children` | `ReactNode` | -- |
| `className` | `string` | -- |

**Internal styling:**
- Trigger button: `"flex cursor-pointer items-center gap-1 text-sm text-kumo-link select-none"`
- Content panel: `"my-2 space-y-4 border-l-2 border-kumo-fill pl-4"` (left border accent)
- Chevron animation: `CaretDownIcon` with classes `"h-4 w-4 transition-transform"` + `"rotate-180"` when expanded

**Accessibility:** `aria-expanded` on button, `aria-controls` linking to content via `useId()`.

**Tokens used:** `border-kumo-fill`, `text-kumo-link`

**Animation approach:**
The chevron uses CSS `transition-transform` for smooth 180-degree rotation. Content conditionally renders when `open` is true. The component uses `useCallback()` for toggle handler optimization and `useId()` for unique content identifiers.

**Examples:**

```tsx
{/* Basic */}
<Collapsible label="What is Kumo?">
  Kumo is Cloudflare's new design system.
</Collapsible>

{/* Controlled */}
<Collapsible label="Details" open={isOpen} onOpenChange={setIsOpen}>
  Detailed content here.
</Collapsible>

{/* Stacked accordion */}
<div className="space-y-2">
  <Collapsible label="Question 1">Answer 1</Collapsible>
  <Collapsible label="Question 2">Answer 2</Collapsible>
  <Collapsible label="Question 3">Answer 3</Collapsible>
</div>
```

---

### Combobox

Searchable select with filtering, single/multiple selection, and chip display.

**Import:** `import { Combobox } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `items` | `T[]` | -- |
| `value` | `T \| T[]` | -- |
| `onValueChange` | `(value: T \| T[]) => void` | -- |
| `multiple` | `boolean` | -- |
| `label` | `ReactNode` | -- |
| `description` | `ReactNode` | -- |
| `error` | `string \| object` | -- |
| `required` | `boolean` | -- |
| `inputSide` | `"right" \| "top"` | -- |
| `isItemEqualToValue` | `(item, value) => boolean` | -- |
| `size` | `"xs" \| "sm" \| "base" \| "lg"` | `"base"` |

**Sub-components:** `TriggerInput`, `TriggerValue`, `TriggerMultipleWithInput`, `Content`, `Input`, `List`, `Empty`, `Item`, `Chip`, `Group`, `GroupLabel`, `Collection`

**Tokens used:** `bg-kumo-control`, `bg-kumo-overlay`, `ring-kumo-line`, `text-kumo-default`

---

### CommandPalette

Composable command palette for search and command dialogs.

**Import:** `import { CommandPalette } from "@cloudflare/kumo";`

**Root Props:**

| Prop | Type |
|------|------|
| `open` | `boolean` (required) |
| `onOpenChange` | `(open: boolean) => void` |
| `items` | `T[]` |
| `value` | `T` |
| `onValueChange` | `(value: T) => void` |
| `onSelect` | `(value: T) => void` |

**Sub-components (14 total):**

| Sub-component | Purpose |
|---------------|---------|
| `Root` | Main wrapper (Dialog + Autocomplete) |
| `Dialog` | Modal dialog wrapper |
| `Panel` | Autocomplete panel (no dialog) |
| `Input` | Search field with auto-focus |
| `List` | Scrollable results container |
| `Results` | Render prop iterator for items/groups |
| `Group` | Category grouping |
| `GroupLabel` | Section header |
| `Items` | Render prop iterator for grouped items |
| `Item` | Basic selectable item |
| `ResultItem` | Rich item with breadcrumbs, icons, highlighting |
| `Empty` | No results state |
| `Loading` | Loading spinner |
| `Footer` | Keyboard hints / supplementary content |
| `HighlightedText` | Text with match highlighting |

**Keyboard:** Up/Down (navigate), Enter (select), Cmd/Ctrl+Enter (new tab), Escape (close).

**Tokens used:** `bg-kumo-elevated`, `bg-kumo-overlay`, `ring-kumo-line`

---

### DatePicker

Calendar date picker supporting single, multiple, and range selection.

**Import:** `import { DatePicker } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `mode` | `"single" \| "multiple" \| "range"` | -- |
| `selected` | `Date \| Date[] \| DateRange` | -- |
| `onChange` | callback | -- |
| `max` | `number` | -- |
| `disabled` | `boolean` | -- |
| `numberOfMonths` | `number` | -- |
| `footer` | `ReactNode` | -- |

Built on react-day-picker with Kumo styling. Can be wrapped in Popover for dropdown behavior.

**Tokens used:** `bg-kumo-base`

---

### DateRangePicker

Dual-calendar date range selector with timezone support.

**Import:** `import { DateRangePicker } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `size` | `"sm" \| "base" \| "lg"` | -- |
| `variant` | -- | -- |
| `timezone` | string | -- |
| `onStartDateChange` | callback | -- |
| `onEndDateChange` | callback | -- |

**Size widths:** sm (168px), base (196px), lg (252px) calendar widths.

**Tokens used:** `bg-kumo-base`, `bg-kumo-contrast`, `bg-kumo-fill`, `text-kumo-default`

---

### Dialog

Modal window overlaid on the primary content, making underlying content inert.

**Import:** `import { Dialog } from "@cloudflare/kumo";`

**Dialog Props:**

| Prop | Type | Default |
|------|------|---------|
| `size` | `"base" \| "sm" \| "lg" \| "xl"` | `"base"` |
| `className` | `string` | -- |
| `children` | `ReactNode` | -- |

**Dialog.Root Props:**

| Prop | Type | Default |
|------|------|---------|
| `role` | `"dialog" \| "alertdialog"` | `"dialog"` |
| `disablePointerDismissal` | `boolean` | `false` |

**Sub-components:** `Root`, `Trigger`, `Title`, `Description`, `Close`

**Size range:** 288px (sm) to 768px (xl).

**Semantic roles:**
- `role="dialog"` -- General-purpose modals, forms, content display. Dismissible by default.
- `role="alertdialog"` -- Destructive actions, confirmations, critical warnings. Requires explicit acknowledgment.

**Tokens used:** `bg-kumo-base`, `bg-kumo-overlay`, `text-kumo-subtle`, `bg-kumo-danger/20`

**Examples:**

```tsx
<Dialog.Root>
  <Dialog.Trigger render={(p) => <Button {...p}>Open</Button>} />
  <Dialog>
    <Dialog.Title>Dialog Title</Dialog.Title>
    <Dialog.Description>Content here.</Dialog.Description>
    <Dialog.Close render={(p) => <Button {...p}>Cancel</Button>} />
  </Dialog>
</Dialog.Root>

{/* Alert dialog for destructive actions */}
<Dialog.Root role="alertdialog">
  <Dialog.Trigger render={(p) => <Button variant="destructive" {...p}>Delete</Button>} />
  <Dialog>
    <Dialog.Title>Are you sure?</Dialog.Title>
    <Dialog.Description>This action cannot be undone.</Dialog.Description>
    <Dialog.Close render={(p) => <Button variant="destructive" {...p}>Confirm Delete</Button>} />
  </Dialog>
</Dialog.Root>
```

---

### DropdownMenu

Action menu triggered by a button, with support for submenus, checkboxes, and radio groups.

**Import:** `import { DropdownMenu } from "@cloudflare/kumo";`

**DropdownMenu Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"default" \| "danger"` | `"default"` |

**Sub-components:**

| Sub-component | Purpose |
|---------------|---------|
| `Trigger` | Opens dropdown; accepts `render` prop |
| `Content` | Container for menu items |
| `Item` | Standard action item; accepts `icon` prop |
| `LinkItem` | Navigation link (renders `<a>`); accepts `href`, `target`, `rel` |
| `CheckboxItem` | Toggleable option; `checked`, `onCheckedChange` |
| `RadioGroup` | Groups radio items for single-selection |
| `RadioItem` | Radio button item; `value` |
| `RadioItemIndicator` | Checkmark for selected RadioItem |
| `Sub` | Nested submenu container |
| `SubTrigger` | Opens nested submenu (caret icon auto-added) |
| `SubContent` | Container for submenu items |
| `Group` | Groups related items |
| `Label` | Text label for groups |
| `Separator` | Visual divider |

**Tokens used:** `bg-kumo-overlay`, `bg-kumo-control`, `text-kumo-danger`

**Examples:**

```tsx
{/* Basic */}
<DropdownMenu>
  <DropdownMenu.Trigger render={<Button>Menu</Button>} />
  <DropdownMenu.Content>
    <DropdownMenu.Item>Option 1</DropdownMenu.Item>
    <DropdownMenu.Item>Option 2</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu>

{/* With icons */}
<DropdownMenu.Item icon={PlusIcon}>Worker</DropdownMenu.Item>

{/* With submenus */}
<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger>More Options</DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent>
    <DropdownMenu.Item>Sub Option 1</DropdownMenu.Item>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>

{/* Radio group */}
<DropdownMenu.RadioGroup value={lang} onValueChange={setLang}>
  <DropdownMenu.RadioItem value="en">English</DropdownMenu.RadioItem>
  <DropdownMenu.RadioItem value="es">Spanish</DropdownMenu.RadioItem>
</DropdownMenu.RadioGroup>
```

---

### Grid

Responsive layout grid with preset column configurations.

**Import:** `import { Grid } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"2up" \| "3up" \| "4up" \| "6up" \| "side-by-side" \| "2-1" \| "1-2" \| "1-3up" \| "1-2-4up"` | -- |
| `gap` | `"none" \| "sm" \| "base" \| "lg"` | -- |
| `mobileDivider` | `boolean` | -- |

**Tokens used:** `border-kumo-line`

Automatically adjusts columns based on viewport breakpoints.

---

### Input

Text input field with built-in label, description, and error support.

**Import:** `import { Input } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `label` | `ReactNode` | -- |
| `labelTooltip` | `ReactNode` | -- |
| `description` | `ReactNode` | -- |
| `error` | `string \| ValidityState object` | -- |
| `size` | `"xs" \| "sm" \| "base" \| "lg"` | `"base"` |
| `variant` | `"default" \| "error"` | `"default"` |
| `required` | `boolean` | `true` |
| `disabled` | `boolean` | `false` |
| `type` | `string` | `"text"` |
| `placeholder` | `string` | -- |

**Validation error objects** match HTML5 ValidityState keys: `valueMissing`, `typeMismatch`, `patternMismatch`, `tooShort`, `tooLong`, `rangeUnderflow`, `rangeOverflow`, or `true` for always-visible.

**Tokens used:** `bg-kumo-control`, `ring-kumo-line`, `ring-kumo-ring`, `text-kumo-default`

**Accessibility:** Inputs require accessible names via `label` prop (recommended), `aria-label`, or `aria-labelledby`. Missing names trigger dev console warnings.

**Examples:**

```tsx
{/* With Field wrapper (recommended) */}
<Input label="Email" type="email" placeholder="you@example.com" />

{/* With description */}
<Input label="Password" type="password" description="Must be at least 8 characters" />

{/* With error */}
<Input label="Username" error="Username is already taken" variant="error" />

{/* Bare input (must provide aria-label) */}
<Input aria-label="Search" placeholder="Search..." />
```

---

### Label

Label component for form controls with optional indicator and tooltip.

**Import:** `import { Label } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `children` | `ReactNode` | -- |
| `showOptional` | `boolean` | -- |
| `tooltip` | `ReactNode` | -- |
| `htmlFor` | `string` | -- |
| `asContent` | `boolean` | -- |

**Tokens used:** `text-kumo-default`, `text-kumo-strong`

---

### MenuBar

Horizontal toolbar with arrow-key navigation and active highlighting.

**Import:** `import { MenuBar } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `isActive` | `boolean` | -- |
| `options` | `Array<{ icon, id, tooltip, onClick }>` | **required** |
| `optionIds` | `string[]` | -- |
| `className` | `string` | -- |

**Tokens used:** `bg-kumo-base`, `bg-kumo-fill`, `border-kumo-fill`

---

### Meter

Progress/quota display with label and value.

**Import:** `import { Meter } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `label` | `string` | **required** |
| `value` | `number` | -- |
| `max` | `number` | `100` |
| `min` | `number` | `0` |
| `showValue` | `boolean` | -- |
| `customValue` | `string` | -- |
| `trackClassName` | `string` | -- |
| `indicatorClassName` | `string` | -- |

**Tokens used:** `bg-kumo-fill`, `text-kumo-default`, `text-kumo-strong`

**Example:**

```tsx
<Meter label="Storage used" value={65} />
<Meter label="Workers" value={750} max={1000} customValue="750 / 1,000" />
```

---

### Pagination

Page navigation component for paginated content.

**Import:** `import { Pagination } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `page` | `number` | -- |
| `setPage` | `(page: number) => void` | -- |
| `perPage` | `number` | -- |
| `totalCount` | `number` | -- |
| `controls` | `"full" \| "simple"` | `"full"` |
| `text` | `(info) => string` | -- |
| `className` | `string` | -- |

**Sub-components:** `Info`, `Controls`, `PageSize` (options default `[25, 50, 100, 250]`), `Separator`

**Controls modes:**
- `full` -- First, previous, page input, next, last buttons
- `simple` -- Previous/next only

**Tokens used:** `border-kumo-line`, `text-kumo-strong`

---

### Popover

Accessible popup anchored to a trigger element for rich interactive content.

**Import:** `import { Popover } from "@cloudflare/kumo";`

**Root Props:**

| Prop | Type | Default |
|------|------|---------|
| `side` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` |

**Sub-components:**

| Sub-component | Key Props |
|---------------|-----------|
| `Trigger` | `asChild`, `openOnHover`, `delay` |
| `Content` | `positionMethod` (`"fixed"` for escaping stacking contexts), `align`, `sideOffset`, `alignOffset` |
| `Title` | -- |
| `Description` | -- |
| `Close` | `asChild` |

**Tokens used:** `bg-kumo-base`, `fill-kumo-base`, `text-kumo-default`

**Popover vs Tooltip:** Popovers are for rich, interactive content with focus management. Tooltips are for short, non-interactive text labels.

**Example:**

```tsx
<Popover>
  <Popover.Trigger asChild>
    <Button>Open</Button>
  </Popover.Trigger>
  <Popover.Content>
    <Popover.Title>Popover Title</Popover.Title>
    <Popover.Description>Content here.</Popover.Description>
  </Popover.Content>
</Popover>
```

---

### Radio

Radio button group for single-option selection.

**Import:** `import { Radio } from "@cloudflare/kumo";`

**Radio.Group Props:**

| Prop | Type | Default |
|------|------|---------|
| `legend` | `string` | **required** |
| `defaultValue` | `string` | -- |
| `orientation` | `"vertical" \| "horizontal"` | `"vertical"` |
| `description` | `ReactNode` | -- |
| `error` | `string` | -- |
| `disabled` | `boolean` | -- |
| `controlPosition` | `"start" \| "end"` | `"start"` |

**Radio.Item Props:**

| Prop | Type | Default |
|------|------|---------|
| `label` | `string` | -- |
| `value` | `string` | -- |
| `disabled` | `boolean` | -- |
| `variant` | `"error"` | -- |

**Tokens used:** `bg-kumo-base`, `ring-kumo-line`, `ring-kumo-ring`

**Keyboard:** Arrow keys navigate, Space selects, Tab focuses.

**Example:**

```tsx
<Radio.Group legend="Choose an option" defaultValue="a">
  <Radio.Item label="Option A" value="a" />
  <Radio.Item label="Option B" value="b" />
  <Radio.Item label="Option C" value="c" />
</Radio.Group>
```

---

### Select

Dropdown list of options triggered by a button.

**Import:** `import { Select } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `value` | `string \| null` | -- |
| `onValueChange` | `(value) => void` | -- |
| `items` | `Record<string, string> \| T[]` | -- |
| `multiple` | `boolean` | -- |
| `loading` | `boolean` | -- |
| `disabled` | `boolean` | -- |
| `placeholder` | `string` | -- |
| `renderValue` | `(value) => ReactNode` | -- |
| `isItemEqualToValue` | `(item, value) => boolean` | -- |
| `label` | `ReactNode` | -- |
| `error` | `string \| object` | -- |
| `description` | `ReactNode` | -- |
| `defaultValue` | `string` | -- |

**Sub-component:** `Select.Option` -- accepts `value` prop and children.

**Important:** Use `value: null` (not empty string or undefined) for the placeholder state to prevent uncontrolled behavior.

**Tokens used:** `bg-kumo-control`, `bg-kumo-overlay`, `ring-kumo-line`

**Examples:**

```tsx
{/* With items object */}
<Select
  label="Fruit"
  items={{ apple: "Apple", banana: "Banana", cherry: "Cherry" }}
  value={fruit}
  onValueChange={setFruit}
/>

{/* With Option sub-components */}
<Select label="Region" value={region} onValueChange={setRegion}>
  <Select.Option value="us-east">US East</Select.Option>
  <Select.Option value="us-west">US West</Select.Option>
  <Select.Option value="eu-west">EU West</Select.Option>
</Select>

{/* Multiple selection */}
<Select
  label="Tags"
  multiple
  items={{ a: "Alpha", b: "Bravo", c: "Charlie" }}
  value={tags}
  onValueChange={setTags}
  renderValue={(v) => v.join(", ")}
/>
```

---

### Surface

Container component providing consistent elevation and border styling.

**Import:** `import { Surface } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `as` | `React.ElementType` | `"div"` |
| `className` | `string` | -- |
| `children` | `ReactNode` | -- |

Polymorphic -- can render as `section`, `article`, `aside`, or `div`.

Surfaces can be nested for layered interfaces using the surface hierarchy: `bg-kumo-base` -> `bg-kumo-elevated` -> `bg-kumo-recessed`.

**Example:**

```tsx
<Surface as="section" className="rounded-lg p-6">
  <Text variant="heading3">Card Title</Text>
  <Surface className="rounded-md p-4 bg-kumo-elevated">
    Nested elevated content
  </Surface>
</Surface>
```

---

### Switch

Two-state toggle button (on/off).

**Import:** `import { Switch } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"default" \| "error"` | `"default"` |
| `label` | `ReactNode` | -- |
| `labelTooltip` | `ReactNode` | -- |
| `required` | `boolean` | -- |
| `controlFirst` | `boolean` | -- |
| `size` | `"sm" \| "base" \| "lg"` | `"base"` |
| `checked` | `boolean` | -- |
| `disabled` | `boolean` | -- |
| `onClick` | `(event) => void` | -- |
| `onCheckedChange` | `(val: boolean) => void` | -- |

Built on Base UI's switch component.

**Example:**

```tsx
<Switch checked={checked} onCheckedChange={setChecked} />
<Switch label="Enable notifications" checked={on} onCheckedChange={setOn} />
<Switch label="Dark mode" size="sm" checked={dark} onCheckedChange={setDark} />
```

---

### Table

Semantic HTML table with selection, row variants, and column sizing.

**Import:** `import { Table } from "@cloudflare/kumo";`

**Table Props:**

| Prop | Type | Default |
|------|------|---------|
| `layout` | `"auto" \| "fixed"` | `"auto"` |
| `variant` | `"default" \| "selected"` | `"default"` |
| `className` | `string` | -- |

**Sub-components:**

| Sub-component | Renders | Purpose |
|---------------|---------|---------|
| `Table.Header` | `<thead>` | Header section (supports `variant="compact"`) |
| `Table.Body` | `<tbody>` | Body section |
| `Table.Row` | `<tr>` | Row (supports `variant="selected"`) |
| `Table.Head` | `<th>` | Header cell |
| `Table.Cell` | `<td>` | Body cell |
| `Table.CheckHead` | `<th>` + checkbox | Select-all |
| `Table.CheckCell` | `<td>` + checkbox | Row selection |
| `Table.ResizeHandle` | draggable | Column resizing |

Designed for TanStack Table integration (sorting, filtering, resizing).

**Example:**

```tsx
<Table layout="fixed">
  <colgroup>
    <col style={{ width: "40px" }} />
    <col />
    <col />
  </colgroup>
  <Table.Header>
    <Table.Row>
      <Table.CheckHead />
      <Table.Head>Name</Table.Head>
      <Table.Head>Status</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    <Table.Row variant="selected">
      <Table.CheckCell checked />
      <Table.Cell>my-worker</Table.Cell>
      <Table.Cell>Active</Table.Cell>
    </Table.Row>
  </Table.Body>
</Table>
```

---

### Tabs

Layered content sections displayed one at a time with animated indicators.

**Import:** `import { Tabs } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `tabs` | `TabsItem[]` | **required** |
| `value` | `string` | -- |
| `selectedValue` | `string` | -- |
| `variant` | `"segmented" \| "underline"` | `"segmented"` |
| `onValueChange` | `(value: string) => void` | -- |
| `activateOnFocus` | `boolean` | -- |
| `className` | `string` | -- |
| `listClassName` | `string` | -- |
| `indicatorClassName` | `string` | -- |

**TabsItem:** `{ value: string, label: ReactNode, className?: string }`

**Variants:**
- `segmented` -- Pill-shaped indicator slides between tabs on a subtle background
- `underline` -- Bottom border with primary-colored indicator; active tab has bolder text

**Features:** Horizontal auto-scroll for many tabs, keyboard navigation via arrow keys, controlled and uncontrolled modes.

**Example:**

```tsx
<Tabs
  variant="segmented"
  tabs={[
    { value: "overview", label: "Overview" },
    { value: "settings", label: "Settings" },
    { value: "logs", label: "Logs" },
  ]}
  value={activeTab}
  onValueChange={setActiveTab}
/>

<Tabs
  variant="underline"
  tabs={[
    { value: "code", label: "Code" },
    { value: "preview", label: "Preview" },
  ]}
/>
```

---

### Text

Typography component for headings and body copy.

**Import:** `import { Text } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"heading1" \| "heading2" \| "heading3" \| "body" \| "secondary" \| "success" \| "error" \| "mono" \| "mono-secondary"` | `"body"` |
| `size` | `"xs" \| "sm" \| "base" \| "lg"` | `"base"` |
| `bold` | `boolean` | -- |
| `as` | `React.ElementType` | -- |
| `children` | `ReactNode` | -- |

**Variant details:**
- `heading1` -- 30px, semibold
- `heading2` -- 24px, semibold
- `heading3` -- 18px, semibold
- `body` -- Default body text
- `secondary` -- Muted body text
- `success` -- Success-colored text
- `error` -- Error-colored text
- `mono` -- Monospace text
- `mono-secondary` -- Muted monospace text

**Restrictions:**
- `bold` and `size` work only with `body`, `secondary`, `success`, `error`
- Monospace variants support only `size="lg"`, no `bold`
- Heading variants cannot use `bold` or `size`

**Tokens used:** `kumo-base`, `kumo-line`, `kumo-subtle`, `kumo-secondary`

**Example:**

```tsx
<Text variant="heading1" as="h1">Page Title</Text>
<Text variant="heading2" as="h2">Section Title</Text>
<Text variant="body">Regular body text</Text>
<Text variant="secondary" size="sm">Small muted text</Text>
<Text variant="error">Something went wrong</Text>
<Text variant="mono">console.log("hello")</Text>
```

---

### Toast

Notification system for brief, non-intrusive messages.

**Import:** `import { Toasty, useKumoToastManager } from "@cloudflare/kumo";`

**Setup:** Wrap your app with `<Toasty>`:

```tsx
import { Toasty } from "@cloudflare/kumo";

export function Layout({ children }) {
  return <Toasty>{children}</Toasty>;
}
```

**Toasty Props:**

| Prop | Type | Default |
|------|------|---------|
| `variant` | `"default" \| "error" \| "warning"` | `"default"` |
| `className` | `string` | -- |
| `children` | `ReactNode` | -- |

**Toast Options (passed to `toastManager.add()`):**

| Option | Type | Default |
|--------|------|---------|
| `title` | `string` | -- |
| `description` | `string` | -- |
| `variant` | `"default" \| "error" \| "warning"` | `"default"` |
| `content` | `ReactNode` | -- |
| `actions` | `ButtonProps[]` | -- |
| `timeout` | `number` | `5000` |

**Behavior:** Multiple toasts stack and animate. Hovering expands the stack. Auto-dismiss after timeout. Custom `content` replaces title/description.

**Examples:**

```tsx
const toastManager = useKumoToastManager();

// Basic
toastManager.add({ title: "Settings saved" });

// With description
toastManager.add({
  title: "Toast created",
  description: "This is a toast notification."
});

// Error variant
toastManager.add({
  title: "Deployment failed",
  description: "Unable to connect to the server.",
  variant: "error"
});

// With action buttons
toastManager.add({
  title: "Need help?",
  description: "Get assistance with your deployment.",
  actions: [
    { children: "Support", variant: "secondary" },
    { children: "Ask AI", variant: "primary" }
  ]
});

// Custom content
toastManager.add({
  content: (
    <div className="flex items-center gap-2">
      <CheckCircleIcon />
      <Link href="/">my-first-worker</Link> created!
    </div>
  )
});

// Promise-based (async operation tracking)
toastManager.promise(deployWorker(), {
  loading: { title: "Deploying...", description: "Please wait." },
  success: (data) => ({
    title: "Deployed!",
    description: `Worker "${data.name}" is live.`
  }),
  error: (err) => ({
    title: "Failed",
    description: err.message,
    variant: "error"
  })
});
```

---

### Tooltip

Information overlay on hover/focus.

**Import:** `import { Tooltip, TooltipProvider } from "@cloudflare/kumo";`

**Props:**

| Prop | Type | Default |
|------|------|---------|
| `side` | `"top" \| "bottom" \| "left" \| "right"` | `"top"` |
| `content` | `ReactNode` | **required** |
| `asChild` | `boolean` | -- |
| `className` | `string` | -- |

**Requires `TooltipProvider` wrapper.**

**Example:**

```tsx
<TooltipProvider>
  <Tooltip content="Tooltip text" asChild>
    <Button>Hover me</Button>
  </Tooltip>
</TooltipProvider>

{/* Icon button with tooltip */}
<TooltipProvider>
  <Tooltip content="Settings" asChild>
    <Button shape="square" icon={GearIcon} aria-label="Settings" />
  </Tooltip>
</TooltipProvider>
```

---

## Accessibility

### Built-in Approach

Kumo is built on Base UI, which handles accessibility fundamentals automatically:

- **ARIA attributes** -- Managed internally by Base UI primitives. Components like Collapsible set `aria-expanded` and `aria-controls`; Dialog sets `role="dialog"` or `role="alertdialog"`.
- **Keyboard navigation** -- Arrow keys for menus/tabs/radio groups, Space/Enter for actions, Escape for dismissal, Tab for focus movement.
- **Focus management** -- Dialogs trap focus. Popovers manage focus return. CommandPalette auto-focuses the search input.
- **Semantic HTML** -- Checkbox.Group and Radio.Group use `<fieldset>`/`<legend>`. Table uses semantic `<table>`/`<thead>`/`<tbody>`/`<th>`/`<td>`. LinkItem renders `<a>`.

### Developer Requirements

- **Icon-only buttons** must have `aria-label`.
- **Inputs** require accessible names via `label` prop, `aria-label`, or `aria-labelledby`. Missing names trigger console warnings.
- **Error messages** auto-associate with inputs via ARIA attributes when using the `error` prop.
- **Radio/Checkbox groups** require `legend` prop for screen reader context.

### Color and Contrast

- Semantic tokens auto-adapt for light/dark mode.
- Lint rules enforce semantic token usage (no raw Tailwind colors), ensuring consistent contrast ratios.
- ESLint includes 7 `jsx-a11y` rules for accessibility checks.

---

## Adapting for Vanilla JS/CSS

Kumo is a React + Tailwind v4 library. To adapt its patterns for vanilla JS/CSS (no React, no Tailwind):

### Design Tokens as CSS Custom Properties

The semantic token system maps directly to CSS custom properties. Recreate the token layer:

```css
:root {
  /* Light mode */
  --kumo-text-default: #111827;    /* neutral-900 */
  --kumo-text-inverse: #f3f4f6;   /* neutral-100 */
  --kumo-text-strong: #4b5563;    /* neutral-600 */
  --kumo-text-subtle: #6b7280;    /* neutral-500 */
  --kumo-text-inactive: #9ca3af;  /* neutral-400 */
  --kumo-text-brand: #f6821f;     /* Cloudflare orange */
  --kumo-text-link: #1e40af;      /* blue-800 */

  --kumo-bg-base: #ffffff;
  --kumo-bg-elevated: #f9fafb;
  --kumo-bg-recessed: #f3f4f6;
  --kumo-bg-overlay: rgba(0, 0, 0, 0.5);
  --kumo-bg-tint: rgba(0, 0, 0, 0.04);
  --kumo-bg-control: #f3f4f6;
  --kumo-bg-brand: #f6821f;
  --kumo-bg-danger: #dc2626;
  --kumo-bg-success: #16a34a;
  --kumo-bg-warning: #ca8a04;

  --kumo-border-line: #e5e7eb;
  --kumo-border-fill: #d1d5db;
  --kumo-ring-ring: #3b82f6;
}

@media (prefers-color-scheme: dark) {
  :root {
    --kumo-text-default: #f3f4f6;
    --kumo-text-inverse: #111827;
    --kumo-text-strong: #9ca3af;
    --kumo-text-subtle: #f9fafb;
    --kumo-text-inactive: #4b5563;
    --kumo-text-link: #60a5fa;

    --kumo-bg-base: #000000;
    --kumo-bg-elevated: #111827;
    --kumo-bg-recessed: #1f2937;
    --kumo-bg-control: #1f2937;

    --kumo-border-line: #374151;
    --kumo-border-fill: #4b5563;
  }
}
```

### Collapsible (Vanilla JS + CSS)

The Kumo Collapsible uses a simple pattern: conditional rendering + CSS `transition-transform` on the chevron.

**HTML:**

```html
<div class="collapsible">
  <button class="collapsible-trigger" aria-expanded="false" aria-controls="content-1">
    <svg class="collapsible-chevron" viewBox="0 0 16 16" width="16" height="16">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>
    <span>Question text</span>
  </button>
  <div class="collapsible-content" id="content-1" hidden>
    <p>Answer content here.</p>
  </div>
</div>
```

**CSS:**

```css
.collapsible-trigger {
  display: flex;
  cursor: pointer;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: var(--kumo-text-link);
  user-select: none;
  background: none;
  border: none;
  padding: 0;
}

.collapsible-chevron {
  width: 16px;
  height: 16px;
  transition: transform 150ms ease;
}

.collapsible-trigger[aria-expanded="true"] .collapsible-chevron {
  transform: rotate(180deg);
}

.collapsible-content {
  margin: 8px 0;
  padding-left: 16px;
  border-left: 2px solid var(--kumo-border-fill);
}

/* Animated height (optional, for smooth expand/collapse) */
.collapsible-content {
  overflow: hidden;
  max-height: 0;
  transition: max-height 200ms ease-out;
}

.collapsible-content[data-open="true"] {
  max-height: 500px; /* sufficiently large */
}
```

**JavaScript:**

```javascript
document.querySelectorAll('.collapsible-trigger').forEach(btn => {
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    const content = document.getElementById(btn.getAttribute('aria-controls'));
    if (expanded) {
      content.setAttribute('hidden', '');
      content.dataset.open = 'false';
    } else {
      content.removeAttribute('hidden');
      content.dataset.open = 'true';
    }
  });
});
```

### Button (Vanilla CSS)

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 150ms ease;
}

.btn-primary {
  background: var(--kumo-bg-brand);
  color: white;
}
.btn-primary:hover { background: var(--kumo-bg-brand-hover, #e5761a); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  background: var(--kumo-bg-control);
  color: var(--kumo-text-default);
  border-color: var(--kumo-border-line);
}
.btn-secondary:hover { background: var(--kumo-bg-interact); }

.btn-ghost {
  background: transparent;
  color: var(--kumo-text-default);
}
.btn-ghost:hover { background: var(--kumo-bg-tint); }

.btn-destructive {
  background: var(--kumo-bg-danger);
  color: white;
}
.btn-destructive:hover { opacity: 0.7; }

/* Sizes */
.btn-xs { padding: 4px 8px; font-size: 12px; }
.btn-sm { padding: 6px 12px; font-size: 13px; }
.btn-lg { padding: 10px 20px; font-size: 16px; }

/* Shapes */
.btn-square { padding: 8px; aspect-ratio: 1; }
.btn-circle { padding: 8px; aspect-ratio: 1; border-radius: 50%; }

/* Focus ring */
.btn:focus-visible {
  outline: 2px solid var(--kumo-ring-ring);
  outline-offset: 2px;
}
```

### Dialog (Vanilla JS + CSS)

Use the native `<dialog>` element:

```html
<dialog class="kumo-dialog" id="my-dialog">
  <h2 class="dialog-title">Title</h2>
  <p class="dialog-description">Description text.</p>
  <div class="dialog-actions">
    <button class="btn btn-secondary" onclick="this.closest('dialog').close()">Cancel</button>
    <button class="btn btn-primary">Confirm</button>
  </div>
</dialog>

<button class="btn btn-secondary" onclick="document.getElementById('my-dialog').showModal()">
  Open Dialog
</button>
```

```css
.kumo-dialog {
  background: var(--kumo-bg-base);
  color: var(--kumo-text-default);
  border: 1px solid var(--kumo-border-line);
  border-radius: 12px;
  padding: 24px;
  max-width: 480px;
  width: 90vw;
}

.kumo-dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
}

.dialog-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
}

.dialog-description {
  color: var(--kumo-text-subtle);
  font-size: 14px;
  margin: 0 0 24px;
}

.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

### Dropdown Menu (Vanilla JS)

Use a button + absolutely positioned div:

```html
<div class="dropdown" data-open="false">
  <button class="btn btn-secondary dropdown-trigger" aria-haspopup="true" aria-expanded="false">
    Menu
  </button>
  <div class="dropdown-content" role="menu" hidden>
    <button class="dropdown-item" role="menuitem">Option 1</button>
    <button class="dropdown-item" role="menuitem">Option 2</button>
    <hr class="dropdown-separator" />
    <button class="dropdown-item dropdown-item--danger" role="menuitem">Delete</button>
  </div>
</div>
```

```css
.dropdown { position: relative; display: inline-block; }

.dropdown-content {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 160px;
  background: var(--kumo-bg-base);
  border: 1px solid var(--kumo-border-line);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  z-index: 50;
}

.dropdown-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--kumo-text-default);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}

.dropdown-item:hover { background: var(--kumo-bg-tint); }
.dropdown-item--danger { color: var(--kumo-bg-danger); }
.dropdown-separator { border: none; border-top: 1px solid var(--kumo-border-line); margin: 4px 0; }
```

```javascript
document.querySelectorAll('.dropdown-trigger').forEach(btn => {
  btn.addEventListener('click', () => {
    const dropdown = btn.closest('.dropdown');
    const content = dropdown.querySelector('.dropdown-content');
    const open = dropdown.dataset.open === 'true';
    dropdown.dataset.open = String(!open);
    btn.setAttribute('aria-expanded', String(!open));
    content.hidden = open;
  });
});

// Close on outside click
document.addEventListener('click', (e) => {
  document.querySelectorAll('.dropdown[data-open="true"]').forEach(d => {
    if (!d.contains(e.target)) {
      d.dataset.open = 'false';
      d.querySelector('.dropdown-trigger').setAttribute('aria-expanded', 'false');
      d.querySelector('.dropdown-content').hidden = true;
    }
  });
});
```

### Toast (Vanilla JS)

```html
<div id="toast-container" class="toast-container"></div>
```

```css
.toast-container {
  position: fixed;
  bottom: 16px;
  right: 16px;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  z-index: 9999;
}

.toast {
  background: var(--kumo-bg-base);
  border: 1px solid var(--kumo-border-line);
  border-radius: 8px;
  padding: 12px 16px;
  min-width: 280px;
  max-width: 400px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  animation: toast-in 200ms ease-out;
}

.toast--error { border-left: 3px solid var(--kumo-bg-danger); }
.toast--warning { border-left: 3px solid var(--kumo-bg-warning); }

.toast-title { font-weight: 600; font-size: 14px; color: var(--kumo-text-default); }
.toast-description { font-size: 13px; color: var(--kumo-text-subtle); margin-top: 4px; }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

```javascript
function showToast({ title, description, variant = 'default', timeout = 5000 }) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    ${description ? `<div class="toast-description">${description}</div>` : ''}
  `;
  container.appendChild(toast);
  if (timeout > 0) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 150ms ease';
      setTimeout(() => toast.remove(), 150);
    }, timeout);
  }
}
```

### Tabs (Vanilla JS + CSS)

```html
<div class="tabs" role="tablist">
  <button class="tab active" role="tab" aria-selected="true" data-tab="overview">Overview</button>
  <button class="tab" role="tab" aria-selected="false" data-tab="settings">Settings</button>
  <button class="tab" role="tab" aria-selected="false" data-tab="logs">Logs</button>
</div>
<div class="tab-panel active" role="tabpanel" data-panel="overview">Overview content</div>
<div class="tab-panel" role="tabpanel" data-panel="settings" hidden>Settings content</div>
<div class="tab-panel" role="tabpanel" data-panel="logs" hidden>Logs content</div>
```

```css
.tabs {
  display: flex;
  gap: 2px;
  background: var(--kumo-bg-control);
  border-radius: 8px;
  padding: 2px;
}

.tab {
  flex: 1;
  padding: 6px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--kumo-text-subtle);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 150ms ease;
}

.tab.active, .tab[aria-selected="true"] {
  background: var(--kumo-bg-base);
  color: var(--kumo-text-default);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

/* Underline variant */
.tabs--underline {
  background: none;
  border-bottom: 1px solid var(--kumo-border-line);
  border-radius: 0;
  padding: 0;
  gap: 0;
}

.tabs--underline .tab {
  border-radius: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.tabs--underline .tab.active {
  border-bottom-color: var(--kumo-text-brand);
  font-weight: 600;
  background: none;
  box-shadow: none;
}
```

```javascript
document.querySelectorAll('.tabs').forEach(tablist => {
  tablist.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all
      tablist.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      // Activate clicked
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      // Show panel
      const panels = tablist.parentElement.querySelectorAll('.tab-panel');
      panels.forEach(p => p.hidden = true);
      const target = tablist.parentElement.querySelector(`[data-panel="${tab.dataset.tab}"]`);
      if (target) target.hidden = false;
    });
  });
});
```

### Badge (Vanilla CSS)

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 9999px;
  line-height: 1.4;
}

.badge-primary { background: var(--kumo-bg-contrast, #111827); color: white; }
.badge-secondary { background: var(--kumo-bg-fill); color: var(--kumo-text-default); }
.badge-destructive { background: var(--kumo-bg-danger); color: white; }
.badge-success { background: var(--kumo-bg-success); color: white; }
.badge-outline {
  background: transparent;
  border: 1px solid var(--kumo-border-fill);
  color: var(--kumo-text-default);
}
.badge-beta {
  background: transparent;
  border: 1px dashed var(--kumo-border-brand, var(--kumo-text-brand));
  color: var(--kumo-text-link);
}
```

### Switch (Vanilla JS + CSS)

```html
<button class="switch" role="switch" aria-checked="false" aria-label="Toggle setting">
  <span class="switch-thumb"></span>
</button>
```

```css
.switch {
  width: 36px;
  height: 20px;
  border-radius: 9999px;
  background: var(--kumo-bg-fill);
  border: none;
  cursor: pointer;
  position: relative;
  padding: 2px;
  transition: background 150ms ease;
}

.switch[aria-checked="true"] {
  background: var(--kumo-bg-brand);
}

.switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 150ms ease;
}

.switch[aria-checked="true"] .switch-thumb {
  transform: translateX(16px);
}

.switch:focus-visible {
  outline: 2px solid var(--kumo-ring-ring);
  outline-offset: 2px;
}

/* Sizes */
.switch-sm { width: 28px; height: 16px; }
.switch-sm .switch-thumb { width: 12px; height: 12px; }
.switch-sm[aria-checked="true"] .switch-thumb { transform: translateX(12px); }

.switch-lg { width: 44px; height: 24px; }
.switch-lg .switch-thumb { width: 20px; height: 20px; }
.switch-lg[aria-checked="true"] .switch-thumb { transform: translateX(20px); }
```

```javascript
document.querySelectorAll('.switch').forEach(sw => {
  sw.addEventListener('click', () => {
    const checked = sw.getAttribute('aria-checked') === 'true';
    sw.setAttribute('aria-checked', String(!checked));
  });
});
```

### Input (Vanilla CSS)

```css
.input-field { display: flex; flex-direction: column; gap: 4px; }

.input-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--kumo-text-default);
}

.input {
  padding: 8px 12px;
  font-size: 14px;
  color: var(--kumo-text-default);
  background: var(--kumo-bg-control);
  border: 1px solid var(--kumo-border-line);
  border-radius: 6px;
  outline: none;
  transition: box-shadow 150ms ease;
}

.input:focus {
  box-shadow: 0 0 0 2px var(--kumo-ring-ring);
}

.input--error {
  border-color: var(--kumo-bg-danger);
}

.input--error:focus {
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.3);
}

.input-description {
  font-size: 12px;
  color: var(--kumo-text-subtle);
}

.input-error-msg {
  font-size: 12px;
  color: var(--kumo-bg-danger);
}

/* Sizes */
.input-xs { padding: 4px 8px; font-size: 12px; }
.input-sm { padding: 6px 10px; font-size: 13px; }
.input-lg { padding: 10px 14px; font-size: 16px; }
```

---

## Full Component List

The complete set of 35+ components available in `@cloudflare/kumo`:

| Category | Components |
|----------|-----------|
| **Action** | Button |
| **Input** | Checkbox, Combobox, DatePicker, DateRangePicker, Input, Radio, Select, SensitiveInput, Switch, Textarea |
| **Display** | Badge, Breadcrumbs, ClipboardText, Meter, Separator, Surface, Table, Tabs, Text |
| **Feedback** | Banner, Dialog, Popover, Toast, Tooltip |
| **Navigation** | CommandPalette, DropdownMenu, MenuBar, Pagination |
| **Layout** | Flow, Grid, Label |
| **Charts** | Timeseries, Custom Charts |
| **Blocks** | PageHeader, ResourceList, DeleteResource (installable via CLI, not exported) |

---

## Additional Resources

- **Documentation site:** [kumo-ui.com](https://kumo-ui.com)
- **GitHub repository:** [github.com/cloudflare/kumo](https://github.com/cloudflare/kumo)
- **Component registry (source of truth):** `packages/kumo/ai/component-registry.json`
- **Theme token source:** `packages/kumo/scripts/theme-generator/config.ts`
- **Figma plugin:** `packages/kumo-figma/`
- **AI agent docs:** `AGENTS.md` (root and per-package)
