---
title: Localization and content identity
description: Locale metadata, translation identity, fallback behavior, machine projection compatibility, and review expectations.
docId: crm.localization
locale: en
audience: both
contentVersion: 0.1.0
---

Internationalization is a content contract, not only a language selector. Each published Markdown file declares a stable `docId`, a BCP 47 `locale`, an intended audience, and a content version. A translation uses the same `docId` and a different locale so humans and agents can identify equivalent material without guessing from filenames.

## Current contract

| Field | Rule |
| --- | --- |
| `docId` | Stable `crm.*` identity. The English and Chinese variants of one document share it. |
| `locale` | `en` or `zh-CN` in version `0.1.0`. |
| `audience` | `human`, `agent`, or `both`. It describes primary use, not access control. |
| `contentVersion` | Project content contract version. It is not the manifest schema version. |

The Sumi manifest remains backward-compatible version 1, where `documents` is an array of Markdown paths. Locale metadata lives in frontmatter and is returned by `fetch_doc`. A future structured manifest must use a new schema version rather than replacing version 1 strings with objects.

## Coverage and fallback

Core onboarding, configuration, API, agent, contribution, and troubleshooting pages are maintained in English and Simplified Chinese. Detailed engineering records may initially fall back to English, and the untranslated notice must remain visible. Fallback is a reader aid, not permission to label untranslated content as complete.

## Review requirements

- Preserve normative identifiers, field names, commands, status codes, and error codes across locales.
- Do not translate code, JSON keys, paths, or product names unless the contract defines localized values.
- Verify that paired routes render, machine files exist, and paired documents share `docId` and `contentVersion`.
- Automatic translation may prepare a draft, but an owned review is required before it becomes release evidence.
