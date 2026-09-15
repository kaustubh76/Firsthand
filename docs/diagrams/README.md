# Diagrams

- `firsthand-product.excalidraw` — the whole product as designed (README ideation), one canvas:
  the §8 causal chain, then lanes top→bottom — people & agents · surfaces (user side + gateway) ·
  libraries · Monad contracts · evidence & audit · delivery / stretch / roadmap / non-goals.
  Every box carries a build-status badge (BUILT / PARTIAL / PLANNED / ROADMAP / STRETCH /
  EXTERNAL GATE / NON-GOAL) as an annotation; the boxes are the design, not the build state.
  Arrows are colour-coded flows (① deposit ② query ③ rescind ④ liveness ⑤ audit ⑥ external gate)
  and only travel in the gaps between lanes and columns, so each can be followed on its own.

  Open at <https://excalidraw.com> → File → Open (or the VS Code Excalidraw extension). Boxes,
  labels and badges are grouped and text is bound, so they move as units.

- `generate-product-diagram.py` — regenerates the file (`python3 generate-product-diagram.py
  firsthand-product.excalidraw`). If you hand-edit the `.excalidraw`, treat it as the source of
  truth from then on and fold your edits back into the generator when convenient.
