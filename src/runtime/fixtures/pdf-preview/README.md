# Passive preview fixtures

These files contain generated test content only. They are not user documents.

- `mixed-two-pages.pdf`: two pages of text, embedded Bitstream Vera, the standard Helvetica font, vectors and a generated bitmap.
- `embedded-chinese.pdf`: one original Type3 vector glyph for U+4E2D with a ToUnicode map. It checks embedded Chinese glyph delivery; it does not cover an entire CJK font family.
- `unembedded-chinese.pdf`: STSong-Light text without an embedded font. The passive renderer must reject missing glyph resources rather than return a silently incomplete page.
- `password.pdf`: encrypted copy of the mixed document, with the test-only password `fixture-password`.
- `damaged.pdf`: deliberately invalid PDF bytes.

`fixture.ts` creates byte-exact small PDF cases for malformed embedded fonts, oversized images and a JavaScript OpenAction. Their code is test input, never executed by the app. The locked PDF.js parser is exercised in Node, and native Canvas checks actual pixel generation; neither is a browser Worker or installed WebKit acceptance.

The Python generator is `docs/evidence/2026-10-09-capability-hardening/generate-visual-preview-fixtures.py`. It uses the existing bundled ReportLab/Pillow/pypdf runtime. Bitstream Vera's license is preserved beside the generated documents. The Type3 glyph and colored pixels were authored for these tests.
