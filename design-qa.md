# Farfold design QA

## Evidence

- Source visual truth: `/Users/tw/.codex/generated_images/01a04654-d9c2-7091-8c22-1d8a2103d11d/exec-6ab64445-614a-4589-8e3b-e26395b04ec6.png`
- Formal installed-app screenshot: `/Users/tw/Desktop/farfold/.design-qa/final-formal-app.png`
- Full comparison: `/Users/tw/Desktop/farfold/.design-qa/full-comparison.png`
- Focused comparison: `/Users/tw/Desktop/farfold/.design-qa/focused-comparison.png`
- Source pixels: 1487 x 1058.
- Implementation pixels: 1199 x 768, including the native macOS title bar; device density was captured at 1x by Computer Use.
- Normalization: the source was aspect-preservingly padded to 1199 x 768. It was not stretched or cropped. The source and the available Mac screen have different aspect ratios, so the comparison is proportional rather than false pixel precision.
- Implementation: `/Applications/Farfold.app`, bundle identifier `ai.farfold.desktop`.

## State

The source visual shows an in-flight task with three tools and a queued steering message. The formal app evidence shows the same conversation-first shell with a real resumed Pi Session in its current idle/error state. The configured DeepSeek Provider returns `402 Insufficient Balance`, so a matching in-flight tool state cannot be produced honestly. No fixture data or fake Pi events were injected into the formal application.

## Full-view comparison

The formal app preserves the source composition: restrained warm-white palette, persistent left session rail, compact top conversation bar, broad central transcript, inline runtime identity, and bottom-anchored composer. Main-region proportions and persistent controls remain visible at the smaller available viewport. The implementation deliberately renders actual Farfold sessions and Provider state rather than the source image's illustrative rows.

Required fidelity surfaces:

- Fonts and typography: system San Francisco/PingFang stack, compact navigation text, stronger conversation title, and readable transcript hierarchy match the native macOS direction. No incorrect display font or oversized marketing typography remains.
- Spacing and layout rhythm: sidebar, header, transcript, and composer tracks align with the source. Busy-only composer controls add the source's second control row without changing the idle footprint.
- Colors and tokens: paper, sidebar, borders, muted text, semantic green, warning red, and queued-message green are centralized as CSS tokens and visibly match the source's low-contrast palette.
- Image and icon fidelity: the existing Farfold application icon is reused. Standard controls use Phosphor icons; no emoji, handcrafted SVG, CSS drawing, or placeholder asset substitutes are present.
- Copy and content: assistant identity is Farfold; Pi appears only as the runtime. Session titles, Project names, model, context percentage, queues, tools, and errors come from real Pi/Farfold state.

## Focused-region comparison

The focused evidence compares the two fidelity-critical regions:

- Sidebar: active-session marker, search affordance with Command-K, title/Project/time metadata, and Project filters preserve the source hierarchy while omitting nonexistent mock sessions.
- Composer: border, radius, metadata rail, model lock behavior, context readout, and primary action placement match the source. The screenshot is idle; the source's steering/follow-up segmented control, Stop, and green steering action appear only when Pi is actually working.

## Findings and comparison history

### Iteration 1

- [P2] Header metadata was below the title instead of grouped at the right. Fixed by moving the immutable Project and Pi status into the right-side header cluster with a separator.
- [P2] Active Session and search affordance were weaker than the source. Fixed with the green active rail and a working Command-K search shortcut.
- [P2] Provider failures exposed raw JSON in the transcript. Fixed with a readable, still-explicit `402 Insufficient Balance` recovery message and a regression test.
- Post-fix evidence: `.design-qa/full-comparison.png` and `.design-qa/focused-comparison.png`.

### Final pass

No actionable P0, P1, or P2 visual findings remain in the states that the formal application and real Provider can produce. The source's denser fake history and successful in-flight tool run are not copied because they would misrepresent current product state.

## Primary interactions verified

- Read real Farfold-owned Pi Sessions and filter them by Project.
- Resume the saved Session in the installed application.
- Receive real Pi state, messages, model, and context statistics.
- Send a new prompt and receive the real Provider failure through the Pi event stream.
- Focus session search with Command-K.
- Keep model switching disabled while work is active; expose real Stop, steering, and follow-up commands only through Pi semantics.

## Follow-up polish

- [P3] Capture the in-flight tool/steering visual state in the formal app after a funded Provider is available. This is a residual evidence gap, not a reason to add synthetic runtime state.

final result: passed
