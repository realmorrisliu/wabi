---
description: Worker implements, reviewer reviews the implementation
argument-hint: "[task description]"
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Report the review findings.
