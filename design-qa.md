# Design QA

## Dropped CSV structure review and target selection

Final result: **passed**

- Reference: Shimmer post-drop analysis (`CleanShot 2026-07-15 at 13.36.23@2x.png`)
- Implementation: native Desktop dev build at 1180 x 820 (`6d400cb9-edb3-4d4f-a010-3b3e0b8d329c-screenshot.png`)
- Dataset: `personal_finance_dataset_8000_extended.csv` (8,000 rows, 15 columns)

The implementation preserves Shimmer's austere file summary, compact profile cards, and cyan/purple visual grammar while keeping the real animated Rive persona visible above the analysis. All 15 columns, target choice, and primary action remain above the fold with no internal scroll. The second-stage capture (`e3d49f63-5889-4cfd-9617-f8b6d5f2d5fe-screenshot.png`) confirms the cards disappear after target selection, the cyan Rive orb becomes the training focus, and the complete training heading and action render without clipping or overlap. The step labels and primary actions are intentional functional controls; the tiny reset and explanatory mapping copy have been removed.

## Empty-chat sidebar

- Source visual truth: `<local-attachment>/CleanShot 2026-07-15 at 15.52.54@2x.png`
- Implementation screenshot: `<private-temp>/dcb8232b-4c1e-4d1c-8d0e-934ac32d4faf-screenshot.png`
- Full-view comparison: `<private-temp>/understudy-empty-sidebar-comparison.png`
- Viewport: 1292 x 932 logical pixels at 2x scale
- State: native Tauri app, dark theme, navigation expanded, active chat history empty, cached default local model running

## Findings

No actionable P0, P1, or P2 differences remain for the requested change. The active empty-chat rail keeps its existing width, header, archive control, account status, colors, and typography while removing only `No saved chats yet.`. Archived-history mode retains its useful `No archived chats.` explanation.

Required fidelity surfaces:

- Fonts and typography: existing app font family, weights, capitalization, and hierarchy are unchanged.
- Spacing and layout rhythm: the rail, header, archive icon, account footer, composer, and persona retain the source layout; removing the sentence creates intentional quiet space without shifting persistent controls.
- Colors and visual tokens: dark surfaces, muted labels, cyan-ready composer treatment, borders, and white Rive persona remain on the existing product tokens.
- Image quality and asset fidelity: the production Rive persona is retained; no substitute or newly drawn asset was introduced.
- Copy and content: the redundant active-empty-state sentence is absent. The screenshot's red review annotation is source markup, not application content.

## Open Questions

None for this scoped change.

## Focused Region Comparison

A separate crop was not needed: the sidebar is legible at full resolution in the combined same-size comparison, and the sole target is the presence or absence of one short line directly beneath `CHATS`.

## Comparison History

- Initial source finding: the active empty-state sentence consumed attention without adding an action.
- Fix: `Sidebar.tsx` now renders no active empty-state copy while preserving the archived empty-state message.
- Post-fix evidence: the same-size native screenshot and combined comparison show an empty active rail with the header, archive control, and account footer intact.

## Implementation Checklist

- [x] Remove only the active empty-chat sentence.
- [x] Preserve archived empty-state guidance.
- [x] Verify the native app at the source image dimensions and state.
- [x] Confirm the cached default local model is running and selected.

final result: passed

## Trained-model installer focus

- Date: 2026-07-20
- Source: `/var/folders/p8/bn77j4_d6676ws9hw78lqrgh0000gn/T/codex-clipboard-f3da513b-b932-4f9a-84c7-d393eda2caba.png`
- Native implementation: `/var/folders/p8/bn77j4_d6676ws9hw78lqrgh0000gn/T/orca-computer-use/539923fa-266d-4abd-a7b9-bcbb340e4184-screenshot.png`
- Viewport: 1180 x 820 logical pixels at 2x native scale

The default view now contains only the customer task: choose an installed classifier, paste customer feedback, and run locally. Model installation guidance remains visible, but implementation details and historical training runs no longer compete with the primary action. The former Active and Archived controls live under a secondary Previous runs view, where their scope is clear.

The native pass confirmed both views are keyboard-accessible and functional. The installed-model screen fits without clipping or internal scrolling, uses the existing dark surfaces and cyan focus language, and keeps the primary action aligned with its input. Previous runs still exposes the full list, selection details, Active and Archived controls, and run actions without changing their behavior.

No actionable P0, P1, or P2 visual or interaction issues remain for this scoped simplification.

final result: passed

## Local classifier training progress

- Reference capture: `outputs/training-design-qa/reference-training-1180x820.png`
- Native capture: `eb95f01c-8835-49bd-b5d4-a53ed860e243-screenshot.png`
- Combined comparison: `outputs/training-design-qa/comparison-reference-native.png`
- Viewport: 1180 x 820 logical pixels at 2x native scale
- State: native Tauri app, ModernBERT epoch 2 of 3, verified local SMS training split

The production view retains the reference's Rive halo as the dominant progress signal, its sparse dark composition, cyan/mint/violet state grammar, and a single cancel action. It adds only truthful operational evidence: measured epoch progress, elapsed time, completed-epoch pace, approximate remaining training time, and a local clock forecast. The forecast remains hidden until the first epoch completes; preparation and evaluation never fabricate a percentage or ETA.

The rotating copy is explicitly labeled as a verified example from the immutable local training split and names its split row without implying that it is the trainer's current row. Sequential fade-out and fade-in timing prevents simultaneous text collisions. Chat-model startup, download, and repair notices are suppressed while dataset preparation or classifier training is active, then return afterward only when the underlying issue still exists.

Native proof completed end to end in 352.2 seconds and produced 99.0% held-out accuracy, 97.6% macro-F1, and a 26.2 ms median local inference result. The combined reference/native comparison shows the halo, hierarchy, status row, example stream, and composer fully visible above the fold with no clipping or overlap.

final result: passed

## CSV training-plan single action

- Reference: `<local-attachment>/CleanShot 2026-07-16 at 10.42.00@2x.png`
- Implementation capture: `outputs/training-plan-single-action.png`
- Viewport: 1280 x 720
- State: five-column CSV profile, `brand_intent_new` selected, training plan ready

Five cards now divide the available profile width evenly (`198px` each at the QA viewport). Every visible column label fits without ellipsis; measured `scrollWidth` equals `clientWidth` for all five. Long training-plan copy wraps instead of truncating. The in-panel training button is gone, and the normal chat composer becomes one `640px`-wide `Train for brand_intent_new` action while the plan is awaiting confirmation.

The existing dark palette, cyan primary action, spacing, borders, typography, and staggered column entrance are preserved. The first capture occurred before the existing `440ms` maximum entrance delay; the implementation evidence was recaptured after the cards settled.

No P0, P1, or P2 visual or interaction issues remain in this state.

final result: passed

## Message scroller reader position

- Date: 2026-07-17
- Reference: shadcn/ui Base Message Scroller, “Tracking the reader’s position”
- Prototype: http://localhost:1426/design
- Viewport: 1280 x 720
- Compared state: transcript outline open at turn 1 of 4

The right-edge trigger remains a quiet stack of small turn ticks, with the current turn in cyan. The outline floats beside the transcript without changing message layout or moving the composer, and follows the existing Understudy typography, spacing, borders, and dark palette. All four turns remain readable and directly selectable; no clipped labels, broken borders, or unintended horizontal overflow were observed.

The rail is a native button with a descriptive turn-position label. Each outline item is a native button, the active turn exposes `aria-current="location"`, and selecting an item uses the scroller's own smooth `scrollToMessage` behavior. The existing “Turn X of Y / Latest” control remains available for returning to the live edge. Reduced-motion mode removes decorative transitions.

One visibility subscription drives the rail and existing position control. The transcript retains `content-visibility: auto` and an intrinsic-size placeholder. Streaming transcript updates cannot rerender the controls unless turn anchors or streaming state change. The quiet rail renders at most 12 sampled ticks for long conversations while keeping the first, current, and final turns represented; the full outline mounts only while its hover or focus surface is open.

final result: passed
