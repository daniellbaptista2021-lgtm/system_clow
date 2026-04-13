---
name: humanizer
description: Rewrite text so it sounds natural, human, and less AI-generated.
category: writing
tags: [writing, rewrite, editing, humanize]
triggers:
  - type: context_match, context: humanize rewrite text natural less ai sound human improve writing
uses_tools: [Read, Write, Edit, Grep, Glob]
---

# Humanizer

Use this skill when the user wants text to sound more natural, less robotic, less promotional, or less obviously AI-generated.

## Goal

Rewrite the text so it reads like a real person wrote it.
Preserve meaning, match the intended tone, and remove common AI writing tells.

## Workflow

1. Read the full text first.
2. Identify obvious AI patterns.
3. Rewrite for natural rhythm, clarity, and personality.
4. Do a final pass asking yourself: "What still sounds AI-generated here?"
5. Tighten again before returning the final version.

## What to remove

- inflated claims of significance like "pivotal", "testament", "underscores the importance"
- promo language like "vibrant", "renowned", "groundbreaking", "stunning"
- vague attribution like "experts say" or "observers note"
- filler like "in order to", "at this point in time", "it is important to note"
- tutorial signposting like "let's dive in" or "here's what you need to know"
- fake depth using -ing phrases like "highlighting", "reflecting", "showcasing"
- formulaic upbeat conclusions
- overuse of em dashes, bold labels, emojis, and title-case headings
- stiff passive voice and subjectless fragments
- rule-of-three padding and repetitive synonym cycling
- chatbot phrasing like "I hope this helps" or "let me know if you'd like"

## What to add

- natural sentence variety
- direct wording
- specific detail when possible
- honest uncertainty when appropriate
- real voice instead of neutral brochure language
- first person only when it genuinely helps the tone

## Style rules

- Prefer simple verbs: is, are, has, does.
- Prefer short concrete sentences over inflated abstractions.
- Keep paragraphs uneven and human.
- Do not over-polish until the text becomes sterile.
- If the user provides a writing sample, match that voice.

## Output format

Return:
1. A clean rewritten version.
2. A short note listing the main AI patterns you removed, only if helpful.

## Quick checks before finishing

- Does this sound like a person, not a content engine?
- Did I remove fluff without flattening the voice?
- Are there any leftover phrases that feel generic, padded, or performatively polished?
