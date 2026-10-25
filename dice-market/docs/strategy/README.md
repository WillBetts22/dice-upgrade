# Strategy notes

The compiled PDF is [`strategy.pdf`](strategy.pdf). `strategy.tex` proves what can be proven about playing Dice Upgrade well (equipment, upgrade values, short selling, worst cases), and explains how the in-game decision review scores each decision. It reads its numbers from `tables.tex`.

`tables.tex` is generated from exact enumeration. Do not edit it by hand; regenerate it with:

```bash
npm run strategy-tables
```

## Compiling

The document needs only standard packages (amsmath, amssymb, amsthm, booktabs, geometry, hyperref).

- **Overleaf:** upload `strategy.tex` and `tables.tex` to a new project and compile with pdfLaTeX.
- **Locally with tectonic:** install tectonic (`brew install tectonic`, or the prebuilt binary from its GitHub releases), then `npm run strategy-pdf`. The first run downloads the LaTeX packages it needs.
- **Locally with TeX Live / MacTeX:** `cd docs/strategy && latexmk -pdf strategy.tex`. Run it twice, or use latexmk, so the table of contents and references resolve.
