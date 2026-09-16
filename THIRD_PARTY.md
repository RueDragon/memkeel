# Third-Party Notices

Memkeel is MIT-licensed. This file records the third-party code it redistributes and the
frontend runtime dependencies of its web console, with the license each one uses.

---

## Vendored code

### obsidian-mind

| | |
| --- | --- |
| Upstream | [`breferrari/obsidian-mind`](https://github.com/breferrari/obsidian-mind) |
| Pinned commit | `af615d100a1d04561409ab9a1e71e615efa1d87b` |
| License | MIT |
| Location in this repository | `vendor/obsidian-mind/` |
| License text preserved at | [`vendor/obsidian-mind/LICENSE`](vendor/obsidian-mind/LICENSE) |

Memkeel vendors a narrow slice of this project, not the whole thing. **Only the pure
injection-budget helpers are imported** — the logic that collapses a set of headed sections to
fit a byte budget, used by `bootstrap` to keep the injected startup summary inside
`budgetBytes`. The vendored files (`session-start.ts`, `regex.ts`) are kept unmodified so they
can be re-diffed against the pinned upstream commit.

`session-start.mjs` and `regex.mjs` beside them are **generated, not vendored**: they are the same
sources with the TypeScript types stripped by Node's own type stripper, produced by
`scripts/build-vendor.mjs` and committed so the published package can be imported from anywhere —
including `node_modules`, where Node refuses to strip types. Each carries a header saying it is
generated, the test suite checks it is in step with its `.ts` source, and any change belongs in the
`.ts` file rather than in the generated one. Nothing about the upstream licence or provenance changes:
the `.ts` files remain the sources of record.

This is a module-level pilot. It is **not** an upstream installation, and it is not a claim to
qmd semantic search, to all upstream commands, or to all-platform hook support. No upstream
runtime, service or CLI is required at any point.

Upstream license text (MIT):

```text
MIT License

Copyright (c) 2026 Brenno Ferrari

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Frontend runtime dependencies

These are used **only by the web console** (`dashboard/app/`, built into the committed
`dashboard/static/` bundle). The core CLI, MCP server, hooks and library have **zero runtime npm
dependencies** — they run on the Node.js standard library alone.

Declared in `dashboard/app/package.json`:

| Package | Declared range | License |
| --- | --- | --- |
| `react` | ^18.3.1 | MIT |
| `react-dom` | ^18.3.1 | MIT |
| `antd` (Ant Design) | ^5.21.6 | MIT |
| `@ant-design/icons` | ^5.5.1 | MIT |
| `@tanstack/react-table` | ^8.20.5 | MIT |
| `echarts` | ^5.5.1 | Apache-2.0 |
| `echarts-for-react` | ^3.0.2 | MIT |
| `react-markdown` | ^9.1.0 | MIT |
| `remark-gfm` | ^4.0.1 | MIT |
| `@fontsource-variable/geist` | ^5.3.0 | OFL-1.1 |
| `@fontsource-variable/jetbrains-mono` | ^5.3.0 | OFL-1.1 |

Build-time only:

| Package | Declared range | License |
| --- | --- | --- |
| `vite` | ^5.4.10 | MIT |
| `@vitejs/plugin-react` | ^4.3.3 | MIT |

### Transitive dependencies

Installing the packages above pulls in their own dependencies, including but not limited to
`zrender` (Apache-2.0, required by ECharts), `dayjs` (MIT, required by Ant Design),
`rc-*` component packages (MIT), and the `unified` / `remark` / `micromark` / `mdast` family
(MIT) behind `react-markdown` and `remark-gfm`. Font files are redistributed under the SIL Open
Font License 1.1 by their respective authors.

### Where the full license texts live

**The complete license text for every one of these packages ships inside the installed
package.** This file records names and license identifiers for attribution and convenience; it
does not reproduce the full texts, and it is not a substitute for them.

You can read any of them locally:

```bash
npm --prefix dashboard/app install
node -e "console.log(require.resolve('antd/package.json'))"   # then open the sibling LICENSE
```

or inspect `dashboard/app/node_modules/<package>/LICENSE` after an install.

`dashboard/app/node_modules/` is **not** committed to this repository (it is git-ignored), so no
third-party license text is redistributed through it. The committed `dashboard/static/` bundle
contains compiled output of these packages; its own notices are covered by the installed
packages listed above.

---

## Not third-party

The following are part of Memkeel itself and are covered by this project's
[MIT license](LICENSE): the CLI, the MCP server, the hook runner and dsh plugin bridge, the
setup and publish tooling, the web console's own source (`dashboard/app/src/`), the test suite,
and the example store under `examples/`.
