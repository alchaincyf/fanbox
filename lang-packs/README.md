# FanBox Language Packs

> 简体中文摘要见文末（[跳转](#简体中文摘要)）。

This directory holds FanBox's UI language packs — JSON data files shipped alongside
the app or authored by third parties. A language pack is **not application code**:
import it via the sidebar's "Switch interface language → Import language pack…" menu
and it takes effect immediately, with no changes to FanBox itself.

- `zh-TW.json` — the official Traditional Chinese pack; usable as a reference
  implementation (and as the worked example throughout this document).
- `TEMPLATE.json` — **the starting point for third-party translators**: contains
  every dict key with identity values (value = key) and identity rules, so it
  **imports as-is** and works immediately. Translate entries progressively and
  re-import (same `id`) to update.

## 1. What a pack is

A language pack is a JSON file shaped like this (excerpt, English → Traditional
Chinese):

```json
{
  "$comment": "FanBox UI dict: keys are ENGLISH source strings (do not translate keys, only values). Missing keys fall back to English. base must be \"en\". See lang-packs/README.md.",
  "base": "en",
  "id": "zh-tw",
  "name": "繁體中文",
  "lang": "zh-TW",
  "dict": {
    "Search all files": "搜尋全部檔案",
    "Favorites": "收藏"
  },
  "rules": [
    ["^(\\d+) minutes? ago$", "$1 分鐘前"]
  ]
}
```

- `base`: **must be the literal string `"en"`**. FanBox's UI source strings are
  English; this field tells the importer "this pack's `dict` keys are English source
  strings from this generation of FanBox". Packs without `base: "en"` (or with any
  other value) target an old, pre-English-base FanBox and are rejected on import —
  see §2.
- `id`: the pack's identifier; determines the saved filename
  (`~/.fanbox/lang-packs/<id>.json`). **Re-importing with the same `id` overwrites**
  the existing pack — this is the primary way to update translations: edit the JSON
  → re-import → reload to take effect.
- `name`: the display name shown in the language menu (e.g. "繁體中文", "日本語").
- `lang`: a BCP-47-style language tag (e.g. `zh-TW`, `ja-JP`, `en`); written to
  `<html lang>`.
- `dict`: the dictionary. **Keys are ENGLISH source strings — never translate the
  keys**, only the values.
- `rules` (optional): handles dynamic strings with variables (e.g. "3 minutes ago",
  "8 items · 2 folders") — see §4.
- `$comment` (optional): the server-side validator ignores unknown top-level keys, so
  you can leave explanatory notes (e.g. pointing here) without affecting
  functionality.

## 2. Hard constraints (`validateLangPack` in `server.js`)

On import, the server checks each of these; **any failure rejects the whole pack**
(nothing is written to disk):

| Field | Constraint | Error message |
|---|---|---|
| top-level | must be a JSON object | `Language pack must be a JSON object` |
| `base` | must be the string `"en"` | `this pack targets an old FanBox text base — please get a pack updated for the English base (base: "en")` |
| `id` | `/^[a-z0-9-]{1,40}$/` (lowercase letters/digits/`-` only, 1-40 chars) | `id has an invalid format (lowercase letters/digits/- only, 1-40 chars)` |
| `name` | non-empty string | `name cannot be empty` |
| `lang` | `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/` (e.g. `zh-TW`, `en`, `ja-JP`, `xx`) | `lang is not a valid language tag (e.g. zh-TW)` |
| `dict` | flat object (no nesting, not an array); keys and values must both be **non-empty** strings | `dict must be a flat object` / `dict keys and values must all be non-empty strings` |
| `rules` (optional) | array of `[regexSource, replacement]` string pairs; each `regexSource` must compile via `new RegExp()` | `rules must be an array` / `each item in rules must be [regex string, replacement string]` / `Invalid regex in rules: <source>` |
| overall size | serialized JSON ≤ 1MB | `Language pack is too large (1MB limit)` |

> Note: `dict` values **cannot be empty strings**. If you don't want to translate an
> entry yet, keep the identity value (value = key) or delete the entry entirely (a
> missing entry falls back to displaying the English source) — never `""`.

> **`base` and breaking changes**: FanBox's source UI language flipped from
> Simplified Chinese to English; `dict` keys are now English strings (previously
> Simplified-Chinese strings). A pack built for the old (pre-flip) FanBox has
> Simplified-Chinese `dict` keys and either no `base` field or `base !== "en"` — it
> is rejected with the error above. If you have an old pack, regenerate it against
> the current `TEMPLATE.json` (English keys, `base: "en"`).

## 3. `dict` semantics

- **Keys are English source strings — never translate the keys.** Every FanBox UI
  string and message is written in English in `public/i18n-dict.js`'s
  `FANBOX_DICT` (as the `dict`'s keys, with Simplified-Chinese values); those exact
  English strings are also your pack's `dict` keys.
- Missing / identity entries: when no translation is found for a string, FanBox
  falls back to displaying the **English** source — no errors, no blanks.
  `TEMPLATE.json` ships with every entry as identity (value = key), which is
  equivalent to "not yet translated".
- **User-content areas are never translated**: file previews, the editor, and the
  embedded terminal are unaffected by language packs — this is FanBox's existing SKIP
  rule; the dictionary only covers static UI text.
- **Product nouns stay untranslated**: `FanBox`, `Claude Code`, `Codex`, `Claude`,
  `Volt`, `Monaco`, `Finder`, `git`, `npm`, `dmg`, `JSON`, `CHANGELOG`, file
  extensions (`.md`, `.png`, …) appear verbatim in both the English source and your
  translated values — don't translate these even when they're embedded inside a
  larger string.
- **Units stay as-is**: `KB` / `MB` / `GB` / `B` (from `fmtSize`) are not part of any
  dict lookup and are never translated.

## 4. `rules` semantics (dynamic strings)

Some UI strings contain variables (numbers, filenames, paths, sizes…) that can't be
matched whole by `dict`. Use `rules` for these:

- Each rule is `[regexSource, replacement]`.
- **The regex must anchor the whole string with `^...$`** (like `dict`, it matches
  the trimmed full string).
- **First-match-wins**: rules are tried top to bottom; the first match stops the
  search — put more specific (longer/special-case) rules **before** more general
  ones.
- The replacement string uses `$1`-`$9` to reference capture groups, same syntax as
  `String.prototype.replace` (`$&` for the whole match is also valid — this is what
  `TEMPLATE.json`'s identity rules use).
- **`·` segment fallback**: if the whole string matches neither `dict` nor `rules`,
  but the string contains ` · ` (space-middot-space), it's split into segments on
  ` · `; each segment is matched against `dict`/`rules` independently — matched
  segments are replaced, unmatched ones keep their source text, then everything is
  rejoined with ` · `. This is why many composite strings (e.g.
  `"5 items · 2 folders · 3 files 2.3 MB"`) can be handled either by one whole-string
  rule or rely on segment fallback as a safety net (or both).
- **JSON escaping gotcha**: a literal newline in the regex *source* must be written
  as `\\n` (backslash + n, which JSON-decodes to `\n` inside the regex). But a
  literal newline in the *replacement* string must be a **real newline** (write `\n`
  in the JSON string literal, which decodes to an actual newline character). Mixing
  these up produces misplaced line breaks or a stray backslash in the output.

### Example 1: plain number substitution, singular/plural

```json
["^(\\d+) minutes? ago$", "$1 分鐘前"]
```

English source strings now have explicit singular/plural forms (`1 minute ago` /
`5 minutes ago`); the regex's `s?` matches both. Matches "3 minutes ago"; `$1` = `3`,
output "3 分鐘前" — Traditional Chinese doesn't distinguish singular/plural, so one
rule covers both English forms. When translating, replace the literal text with your
language while keeping the `$1` placement, e.g. Japanese: `["^(\\d+) minutes? ago$", "$1分前"]`.

### Example 2: error-prefix + multi-line content

```json
["^Just changed:\\n([\\s\\S]+)$", "剛變更：\n$1"]
```

- The newline in the regex source is written as `\\n` (i.e. backslash + n after
  "Just changed:").
- The newline in the replacement is a real newline (a JSON `\n` escape decodes to a
  newline character).
- `([\s\S]+)` matches "any character including newlines", capturing a multi-line
  list of changed files. When translating, replace "Just changed:" with your
  language; keep `\n$1` as-is.

### Example 3 (cautionary): when a capture group contains source-language literal alternatives, split it into separate rules

FanBox's built-in Simplified-Chinese dictionary has one rule for the sidebar's
"Agent project" activity tooltip, implemented as **one** regex with a function that
branches on the captured English time-token (`just now` / `Nm` / `Nh` / `Nd`):

```js
// Built-in dictionary (public/i18n-dict.js), illustration only —
// language packs cannot use functions like this
[/^([\s\S]+)\n(.+) · active (just now|\d+m|\d+h|\d+d)$/, (m) => {
  const t = m[3] === 'just now' ? '刚刚' : m[3].replace(/^(\d+)m$/, '$1分').replace(/^(\d+)h$/, '$1时').replace(/^(\d+)d$/, '$1天');
  return `${m[1]}\n${m[2]} · ${t}前活跃`;
}]
```

**The problem**: a language pack's `rules` only supports string substitution
(`$1`-`$9` filled in verbatim, or `$&` for the whole match) — **no functions, no
branching**. If you copied the regex above as-is into a single `[regex, string]`
rule, the `$3` capture group holds an **English source-language literal alternative**
(`just now`, or `Nm` / `Nh` / `Nd`). Filling it back in via `$3` would insert that
English text **unchanged** into your translation — i.e. the
`(just now|\d+m|\d+h|\d+d)` group's value needs a *different* translated word
depending on which alternative matched, but a single string-replacement rule can't
branch on content.

**The actual fix** (as shipped in `zh-TW.json`): split this one rule into **4
separate rules**, one per alternative branch of the time-token group. Each rule
writes the corresponding Traditional-Chinese literal directly into the replacement
(no longer using `$3`/`$N` for that part); numeric branches get their own capture
group renumbered to avoid colliding with the tooltip's own `$1`/`$2`:

```json
[
  ["^([\\s\\S]+)\\n(.+) · active just now$", "$1\n$2 · 剛剛前活躍"],
  ["^([\\s\\S]+)\\n(.+) · active (\\d+)m$",  "$1\n$2 · $3分前活躍"],
  ["^([\\s\\S]+)\\n(.+) · active (\\d+)h$",  "$1\n$2 · $3時前活躍"],
  ["^([\\s\\S]+)\\n(.+) · active (\\d+)d$",  "$1\n$2 · $3天前活躍"]
]
```

- Rule 1: `just now` is a fixed literal with no variable — translate "active just
  now" as a whole ("剛剛前活躍"), no capture needed for the time token.
- Rules 2-4: each numeric form (`Nm` / `Nh` / `Nd`) gets its own rule; the number
  becomes `$3` (note: NOT `$1` — groups 1 and 2 are already used by the tooltip's
  first line and agent name), and the unit suffix (`分`/`時`/`天`) is written as a
  literal because each English unit maps to a different Chinese character.

**Rule of thumb**: if a capture group's alternation `(a|b|c)` holds source-language
literal alternatives whose translations differ per alternative, you can't fill it
back in via `$N` — split the rule into one variant per alternative, with that part of
the translation written literally. If a capture group only holds content that
doesn't need translation (numbers, paths, filenames, product nouns), `$N` fill-in is
safe and you can keep a single rule (possibly with an optional group, though FanBox's
own rules avoid optional groups in JSON packs in favor of splitting — see
`zh-TW.json`'s handling of `N item(s)[ · N folder(s)][ · N file(s) <size>]`, split
into 4 ordered, non-optional variants).

## 5. Authoring / update workflow

1. Copy `TEMPLATE.json`, rename it (e.g. `ja.json`).
2. Edit the top fields:
   - `base`: keep as `"en"` — do not change this.
   - `id`: your language identifier, e.g. `"ja"`, `"fr"` (`[a-z0-9-]` only, 1-40
     chars).
   - `name`: the display name in the menu, e.g. `"日本語"`.
   - `lang`: the matching BCP-47 tag, e.g. `"ja"`, `"ja-JP"`, `"fr-FR"`.
3. Translate `dict`: change values to your language entry by entry. Entries you
   haven't translated yet can keep their identity value (value = key) or be deleted
   entirely (both fall back to displaying the English source) — **never set a value
   to an empty string**.
4. Port `rules`: starting from `TEMPLATE.json` (identity form, same 71 English
   regexes as the built-in dictionary) and the examples in §4 above, translate the
   replacement strings; pay special attention to Example 3 — rules whose capture
   groups contain source-language literal alternatives need to be split per
   alternative.
5. Validate locally:
   ```bash
   node tests/test_pack_schema.js lang-packs/<your>.json
   ```
   On success it prints `CHECK1 PASS — name: ... | dict entries: ... | rules: ...
   | size: ... bytes`.
6. Start FanBox (`node server.js` or `npm run app`), then use the sidebar's "Switch
   interface language → Import language pack…" to select your JSON file.
7. After import, your language appears in the menu; switching applies immediately,
   `<html lang>` becomes your `lang` value, and it persists across reloads.
8. **Updating translations**: edit the JSON → "Import language pack…" again with the
   same file → **same `id` overwrites** the existing pack → reload to see the new
   text.

## 6. Updating across FanBox versions

Future FanBox versions may add new UI strings (new English keys in
`public/i18n-dict.js`). If a key is missing from your pack, the UI **automatically
falls back to displaying the English source** — no errors, no blanks — but it means
your translation is missing that entry.

To update:
1. Get the new version's `lang-packs/TEMPLATE.json` (its `dict` key set exactly
   matches the new version's `public/i18n-dict.js`).
2. Diff its `dict` keys against your existing pack to find newly added keys.
3. Add those new keys (with identity values) to your pack, then translate them.
4. Re-import (same `id` overwrites) to apply.

---

## 简体中文摘要

本目录存放 FanBox 的界面语言包（JSON 文件），通过侧栏底部「切换界面语言 → 导入语言包…」匯入后立即生效，不需要改动 FanBox 本体。**完整文档以上方英文为准**，以下仅作要点速览：

- FanBox 的界面源语言已改为**英文**：`dict` 的**键是英文原文**（不要翻译键，只翻译值）；缺词条时回退显示**英文**原文（不再是简体中文）。
- 语言包必须带 `base: "en"` 字段；缺失或不为 `"en"` 的旧版语言包会被拒绝匯入，报错提示「请换一个适配英文 base 的语言包」。
- `zh-TW.json` 是官方繁体中文包（可当参考实现）；`TEMPLATE.json` 是给第三方译者的起点（英文 key、恒等值、`base: "en"`，可直接匯入）。
- 制作流程：复制 `TEMPLATE.json` → 改 `id`/`name`/`lang` → 翻译 `dict` 的值 → 按需移植/拆分 `rules`（含变量的动态文案，规则只支持字符串替换，捕获组里若含源语言字面量分支须拆成多条规则）→ `node tests/test_pack_schema.js lang-packs/<your>.json` 校验 → 匯入 → 同 `id` 重新匯入即可覆盖更新。
- 跨版本更新：对比新版 `TEMPLATE.json` 的 `dict` 键集合，补上新增的键再翻译。

详见上方英文正文（schema 字段、硬性约束表、`dict`/`rules` 语义、拆分规则的范例与流程）。
