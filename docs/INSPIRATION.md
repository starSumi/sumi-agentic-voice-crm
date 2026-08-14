---
title: Inspiration and non-copying boundary
description: Pinned comparative projects, the evidence taken from them, and the boundary between inspiration and owned implementation.
docId: crm.inspiration
locale: en
audience: both
contentVersion: 0.1.0
---

The design was informed by two pinned open-source projects:

- `JagadeepPortfolio/saathi-crm`: voice capture, whisper.cpp ASR, structured customer and visit records, signed media URLs, and provider adapters.
- `CopilotKit/CopilotKit/examples/showcases/strands-crm` (Northstar): CRM tool boundaries, a Strands agent, AG-UI events, a SQLite state projection, HITL, and test organization.

The source was studied to reframe the problem boundaries. This repository does not copy source code, documentation passages, screenshots, seed data, prompts, or secrets from either project. Sumi owns and redesigned the target contracts, naming, event model, ownership, audit model, checkpoints, and release path.

Evidence is pinned to Saathi commit `693ec2bd20e546a06238559cc4cb20e342080af2` and Northstar checkout `2328062960a1e9b4b8bc2eb2817724fc624f8785`. These are comparative evidence, not Sumi runtime dependencies.
