---
description: Inspect unnecessary complexity without editing files
argument-hint: "[scope]"
---
Review $@ for unnecessary complexity; default to the current diff. Read the affected code and its callers. Report only evidence-backed opportunities: location, the real requirement currently served, a simpler alternative, behavior that must be preserved, and how to verify equivalence. Prioritize reduced maintenance cost, not fewer lines. Do not remove validation, error handling, accessibility, or meaningful tests. Do not apply changes unless requested. If the code is already appropriate, say so.
