---
"@pokapali/storybook": patch
"@pokapali/react": patch
---

Add component and pattern stories for full Storybook coverage

Fix SaveIndicator button font size: replace `font: inherit`
with `font-family: inherit` so the CSS shorthand doesn't
reset font-size from 0.75rem to the parent's size.
