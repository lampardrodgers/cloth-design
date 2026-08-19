# Design QA — 简易模式预览持久化与生成卡重选

- Source visual truth: `/var/folders/0c/bqxjd30141vbq04z9qzg34br0000gn/T/codex-clipboard-f85ff9da-bc3f-424b-9955-f99c489c1666.png`
- Implementation pending/reselected screenshot: `/tmp/clothdesign-preview-fix.LB49O0/implementation-pending-selected.png`
- Implementation completion screenshot: `/tmp/clothdesign-preview-fix.LB49O0/implementation-complete.png`
- Full-view comparison: `/tmp/clothdesign-preview-fix.LB49O0/comparison-pending-reselect.png`
- Focused result-grid comparison: `/tmp/clothdesign-preview-fix.LB49O0/comparison-focused-results.png`
- Viewport: 1280 × 720 CSS px, desktop, 1× capture density.
- Source pixels: 2862 × 1508 px; normalized to 1366 × 720 for the combined comparison.
- Implementation pixels: 1280 × 720 px; compared at native 1× density.
- State: local demo account, simple/free creation view, two historical results and one selected pending generation card. The source shows the established result-card layout; the implementation adds the requested selectable pending state within that same grid.

## Full-view comparison evidence

- The main two-column composition, top bar, navigation, control density, preview frame, and horizontal result grid retain the source layout.
- After a historical image is opened, the pending card can be selected again; the right preview returns to the dark generation state instead of remaining on the historical image.
- The selected pending card uses the existing gold selection language and remains in the same grid track as completed cards.
- The source used a collapsed navigation rail and production imagery; the local QA capture uses the expanded rail and demo-provider images. These are environment/content differences outside the requested interaction.

## Focused comparison evidence

- Result grid: completed cards keep the original structure and spacing. The pending card occupies the same card footprint, with a clear spinner, `1 / 1` position, prompt, parameters, elapsed time, and “点一下可重新查看生成状态”.
- Selected state: the pending card changes from dashed to solid gold with an inset gold line, matching the visual priority of the source’s selected completed card without changing neighboring cards.
- Preview state: selecting that card restores “正在生成第 1 张图片”; when the task finishes, the corresponding result becomes active automatically and no completion-only popup is shown.

## Required fidelity surfaces

- Fonts and typography: existing serif/display, sans, and mono families, weights, truncation, and small-label hierarchy are reused; no new font treatment was introduced.
- Spacing and layout rhythm: the pending control preserves the existing square thumbnail, card padding, grid gap, footer height, preview alignment, radii, and section rhythm.
- Colors and visual tokens: the state uses existing canvas black, paper, muted copy, gold, gold-line, and gold-tint tokens; contrast remains consistent with completed-card selection.
- Image quality and asset fidelity: completed images are unchanged. The pending state uses the project’s existing Lucide loader and progress treatment; no raster placeholder, custom SVG, or CSS-drawn asset was added.
- Copy and content: the new text explicitly communicates that the pending item is selectable and that selecting it restores automatic completion display.

## Primary interactions tested

1. Clear preview, switch to “账户与积分”, return to “自由创作”: the preview remains empty and the historical result remains stored.
2. Start generation, select a historical result, then select the pending result card: the right preview returns to the corresponding generation state and the card exposes `aria-pressed=true`.
3. Complete the reselected pending task: the matching new result becomes active automatically and no “新图像已完成生成” popup interrupts the flow.
4. Existing manual-override behavior remains: leaving a historical result selected still preserves it and uses the completion notice.
5. Browser console errors: none.

## Findings

- No actionable P0, P1, or P2 visual or interaction mismatch remains in the requested regions.

## Comparison history

- Pass 1 (previous delivery): implemented generation preview, pending cards, non-destructive clear, automatic completion, and manual-selection completion notice.
- Pass 2: found that clear state was component-local and pending cards were display-only. Persisted the preview state across remounts, converted each pending thumbnail into an accessible button, added a clear selected state, and mapped each pending slot to its corresponding completed result. Post-fix browser evidence is the pending/reselected screenshot and focused comparison above.

## Follow-up polish

- No blocking follow-up. Expanded navigation and demo artwork are local QA environment differences, not production design drift.

final result: passed
