# Mindustry HJSON (VSCode extension)

Syntax highlighting, schema-driven autocomplete, unknown-field warnings, and
hover docs for Mindustry mod `.hjson` content files.

**This extension is AI-generated.** Documentation, including this README, is mostly slop.[^1]

# Installing

Download the latest VSIX file from the [releases](https://github.com/Anuken/MindustryHJsonVSCode/releases/latest) tab. In VSCode, open the Extensions tab, click the three dots in the top right -> "Install From VSIX..." -> select the downloaded VSIX file.

I haven't set up proper releases yet.

## Running
```
npm install
npm run compile
```
To actually run the extension in a VSCode Extension Development Host, open
this folder in VSCode and press F5 (needs `@types/vscode` already installed
here; no further setup required for step 1/skeleton testing).

## Development

```
npm install -g @vscode/vsce   # if you want to build a .vsix
vsce package
```

Or just press `F5` in VS Code with this folder open to launch an Extension
Development Host for testing.

## Using

Simply open a (H)JSON mod folder, and browse its content files. Note that *only* HJSON files are supported - files with the JSON extension are not.

## Missing Features

- Some container types aren't resolved properly, e.g. `ObjectFloatMap`
- Vanilla effect names and sounds aren't resolved
- Type checking is not very strict

## Schemas

Schemas are taken from Mindustry's `tools:updateScripts` task, which outputs schemas into `build/schemas`. These are not 'real' JSON schemas - merely descriptions of fields, docs and types encoded into a format that this plugin can easily read.

Each schema file's fields are `{ "fieldName": { "type": "<FQCN or primitive,
optionally generic like arc.struct.Seq<mindustry.type.Weapon>>", "doc":
"...", "default": "..." } }`, plus two optional top-level keys: `"superclass":
"Fully.Qualified.Name"` (fields are inherited, closest-wins on conflicts) and
`"doc": "..."` (class-level documentation, shown when hovering a `type:
SimpleName` value that resolves to this class).

The `type` field itself (used to set/override a content object's type) is
always offered in completion and hover, with a hardcoded doc ("Type of the
object."), independent of whatever schemas are loaded.

## How type resolution works

- Top level: an explicit `type: SimpleName` field wins; otherwise the file's
  path is checked against `mindustryHjson.contentTypeFolders` (defaults:
  `weathers`→Weather, `sectors`→SectorPreset, `items`→Item, `liquids`→Liquid,
  `planets`→Planet, `status`→StatusEffect, `blocks`→Block, `units`→UnitType),
  matching any path segment so both `content/units/foo.hjson` and
  `content/units/vanilla/foo.hjson` resolve to UnitType.
- Nested objects: the enclosing field's schema type is looked up; if that
  field's declared type is a generic like `arc.struct.Seq<mindustry.type.Weapon>`,
  the array's *elements* get the unwrapped element type (`Weapon`) as their
  context, recursively. A two-arg generic like
  `arc.struct.ObjectMap<String, mindustry.type.Item>` is treated as a map: the
  object literal's own entries are arbitrary keys (no unknown-field warnings,
  no field-name completion for them — hovering a key shows the declared Key
  type instead), and each entry's *value* resolves against the Value type,
  recursively, same as any other nested object. A nested object's own
  explicit `type: X` still overrides whatever was inferred for it.
- This walk is shared by diagnostics (visits every node), completion, and
  hover (both resolve just the type at the cursor via `locate.ts`), so all
  three features always agree on "what type is this object".

## Features

1. **Parser** (`src/parser/mhjsonParser.ts`) — from-scratch parser matching
   Mindustry's own relaxed HJSON dialect (optional root braces, optional
   commas, quoteless scalars, `[a, b, c]` / `{a: x, b: y}` on one line,
   `#`/`//`/`/* */` comments, `'''` multiline strings).
   (`npm run test-parser test-fixtures`, or point it at any mod folder).
2. **Syntax highlighting** — `syntaxes/mhjson.tmLanguage.json` +
   `language-configuration.json`; a plain TextMate grammar independent of the
   parser, so files get colored immediately even before schemas load.
3. **Schema loading** — `src/schema/schemaLoader.ts` loads the flat folder of
   `Fully.Qualified.ClassName.json` files, indexed by FQCN and by simple
   name, with superclass field inheritance resolved and cached.
4. **Autocomplete** — `src/features/completion.ts`, driven by
   `src/schema/typeResolver.ts` + `src/features/locate.ts` (see "How type
   resolution works" above). Suggests unused field names (as snippets
   pre-filled with the schema default), and suggests all known simple class
   names when completing a `type: ` value.
5. **Unknown-field warnings** — `src/features/diagnostics.ts` walks the full
   tree and flags any key that isn't in the resolved type's effective field
   set (only once a schema is actually resolved for that object, so
   unrecognized/unschemed types are silently skipped rather than
   over-warning).
6. **Hover docs** — `src/features/hover.ts` shows the field's type, `doc`
   string, and default value (when present) on hover over a key.
7. **`Effect` array shorthand** — a field declared as a bare (non-generic)
   `Effect` type (e.g. `mindustry.entities.Effect`, not `Seq<Effect>`) that's
   given a JSON array literal is treated as Mindustry's `MultiEffect`
   shorthand: every element of the array resolves as its own `Effect`
   (schema fields, completion, hover, diagnostics all apply per-element),
   handled in `TypeContext.forArrayElement` (`src/schema/typeResolver.ts`).
8. **`BulletType` default** — any field/array-element/map-value whose
   declared type resolves to the abstract `mindustry.entities.bullet.BulletType`
   resolves instead to `BasicBulletType` (`mindustry.entities.bullet.BasicBulletType`)
   when there's no explicit `type: X` on the object — matching what Mindustry
   itself instantiates. An explicit `type:` on the object still overrides
   this. Handled centrally in `resolveClassForType` (`src/schema/typeResolver.ts`)
   so it applies uniformly to plain fields, `Seq<BulletType>` elements, and
   `ObjectMap<K, BulletType>` values.
9. **Content resolution** (`src/schema/contentIndex.ts`) — any field whose
   declared type (after unwrapping `Seq<...>`/`ObjectMap<K, V>`) is one of
   `Item`, `Block`, `Liquid`, `Planet`, `SectorPreset`, `StatusEffect`,
   `UnitType`, or `Weather` is treated as a reference to *named content*
   rather than a nested object. The index recursively scans the mod's own
   `items/`, `blocks/`, `liquids/`, `planets/`, `sectors/`, `status/`,
   `units/`, `weathers/` folders (as configured by
   `mindustryHjson.contentTypeFolders` — the same setting used for implicit
   top-level typing) for `.hjson` files, and treats each file's base name
   (without extension, regardless of nesting) as a content name. This lights
   up, only where such a field is relevant:
   - **Autocomplete** of every matching content name found in the mod, for a
     direct scalar field (`liquid: `), an element of a content-typed array
     (`Seq<Item>`), or a key of a content-keyed map (`ObjectMap<Item, ...>`).
   - **Hover** on such a reference shows which file(s) in the mod define it
     (or a note that it wasn't found locally — it may be vanilla content).
   - **Go to definition** (`src/features/definition.ts`) jumps straight to
     the defining file.
   Resolution logic lives in `src/features/locate.ts` (`ContentRef` on
   `LocateResult`); the index itself rebuilds (debounced) on activation and
   whenever `.hjson` files are created/deleted or `contentTypeFolders`
   changes.

`src/extension.ts` wires it all up: loads schemas from
`mindustryHjson.schemaFolder` (or `<workspace>/.mindustry-schemas`, or the
bundled `schemas/` folder), builds the content index, re-lints on open/edit,
registers the completion, hover, and definition providers, and exposes
`Mindustry HJSON: Reload Schemas`.

## Structure
- `src/parser/mhjsonParser.ts` — a from-scratch parser ported directly from
  Mindustry's own `JvalReader`, not the stock `hjson` npm package. Handles:
  optional root braces, optional commas, quoteless ("TFNNS") scalars that
  terminate on `,`/`]`/`}` so `[a, b, c]` and `{a: x, b: y}` work inline,
  `#`/`//`/`/* */` comments, and `'''` multiline strings.
- `src/schema/schemaLoader.ts` — loads the flat folder of
  `Fully.Qualified.ClassName.json` schema files (see `schemas/` for the one
  example you provided) into a registry, indexed by FQCN and by simple name,
  with superclass field inheritance resolved and cached.
- `src/schema/typeResolver.ts` + `src/features/locate.ts` — walks the parsed
  tree to figure out "what schema applies here", handling explicit
  `type: Foo`, implicit types from `contentTypeFolders` (units/, blocks/,
  weathers/, etc., configurable), nested objects, and generic array element
  types like `arc.struct.Seq<mindustry.type.Weapon>`.
- `src/features/diagnostics.ts` — warns on unknown fields once a schema is
  resolved for an object.
- `src/features/completion.ts` / `hover.ts` — field-name completion (with
  snippet default values) and hover docs (type / doc / default), plus
  completion of `type: ` values from all loaded schema simple names.
- `syntaxes/mhjson.tmLanguage.json` + `language-configuration.json` — basic
  TextMate grammar (comments, strings incl. triple-quoted, numbers, bare
  words, brackets) so files get colored immediately, independent of the
  custom parser (the parser drives diagnostics/completion/hover; the grammar
  only drives colors).
- `src/extension.ts` — wires it all up: loads schemas from
  `mindustryHjson.schemaFolder` (or `<workspace>/.mindustry-schemas`, or the
  bundled `schemas/` folder), re-lints on open/edit, registers the
  completion + hover providers.

---

[^1]: If you have concerns about ethics, keep in mind: This was generated on the free tier; I didn't pay for it, nor am I supporting the AI industry in any way. If you have concerns about quality... it's a simple plugin with useful diagnostics, and the alternative is not having a plugin at all. If you still find this objectionable, don't use it.
