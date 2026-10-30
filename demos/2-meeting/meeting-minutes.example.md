# Meeting Minutes — Relay Gateway Submission Endpoint

**Source:** `meeting.mp3` (00:58)
**Date:** Not stated in the recording
**Attendees:** Not stated (no roll call audible)
**Transcription:** Machine transcription via `read_audio`, with a second slowed/filtered pass for cross-checking.

> **Confidence note:** The recording is 16 kHz, 48 kbps mono and several words — including the endpoint's final path segment, the queue name, and the action-item owner — are not intelligible. Those points are marked **Unclear** below rather than guessed. The raw transcript is reproduced in the appendix so every entry can be checked against the source.

## Summary

The team agreed to add a relay-gateway submission endpoint under the existing `/v1/` API prefix, keeping relay traffic under one prefix (00:14–00:24). The request limit is set to 120 requests per minute "for now" (00:24–00:34). Failed requests are to be retried and sent to a queue after three attempts (00:34–00:46). One action item was assigned to write up the endpoint by Friday; the owner's name is not intelligible (00:44–00:52).

**Context, not a decision:** the current routes are `/v1/chat` and `/v1/audio` (00:05–00:15).

## Decisions

| # | Decision | Timestamp | Confidence / notes |
|---|----------|-----------|--------------------|
| D1 | The new relay-gateway submission endpoint will live under the existing `/v1/` prefix as `/v1/relay/…`, so relay traffic stays under one prefix. | 00:14–00:24; recap 00:46–00:58 | **Medium** on the `/v1/relay/` prefix and intent. **Low** on the final segment: heard as "nobs"/"nbs"/"No" in different passes — exact path unresolved (see Q1). |
| D2 | The request limit is **120 requests per minute**, "for now." | 00:24–00:34; recap 00:46–00:58 | **High** on the number. Scope is ambiguous: the closing recap appears to associate 120/min with the **free tier** ("free read" in the ASR), while the earlier wording sounds temporary/global (see Q2). |
| D3 | Failed requests are retried and then sent to a queue after **three attempts**. | 00:34–00:46 | **Medium.** "After 3 attempts" is discernible. The queue name is unintelligible — heard as "manlander" — and may be "dead-letter" (see Q3). |

## Action items

| # | Action | Owner | Due | Timestamp |
|---|--------|-------|-----|-----------|
| A1 | Write up the new `/v1/relay/…` endpoint (spec and/or implementation — not specified). | **Unclear** — the name is unintelligible; heard as "Noah"/"no." Confirm before circulating. | **Friday** — calendar date not stated | 00:44–00:52 |
| A2 | Update the docs/notes for the endpoint. | **Unclear** — apparently the same speaker as A1 ("and I'll update the…"), but the wording is not reliable. | Not stated | 00:46–00:52 |

> A2 is **tentative**. It is included because a second clause follows the action item, but the transcript ("and I up the knocks") is too degraded to treat it as a firm commitment.

## Open questions

| # | Question | Raised / context timestamp | Why it matters |
|---|----------|----------------------------|----------------|
| Q1 | What is the exact final path segment — `/v1/relay/???`? | 00:14–00:24; recap 00:46–00:58 | Blocks implementation, routing, and documentation. |
| Q2 | Is 120 requests/minute **per API key/client or global**, and does it apply only to the **free tier** or to all traffic "for now"? | 00:24–00:34; 00:46–00:58 | The earlier "for now" and the closing "free tier" wording are not reconciled in the recording. |
| Q3 | Which queue receives failures after three attempts, and what are the retry/backoff rules and the definition of a failed attempt? | 00:34–00:46 | Only "three attempts" is clear; the queue name is not intelligible. |
| Q4 | Who owns A1, is the deliverable a spec or working code, and which calendar Friday is the deadline? | 00:44–00:52 | Owner, deliverable type, and date are all unstated or unintelligible. |
| Q5 | Do the existing `/v1/chat` and `/v1/audio` routes remain unchanged, or do they also move under the relay prefix? | 00:05–00:15 | Clarifies the scope of "everything under one prefix." |

## Appendix — ASR transcript (verbatim, uncorrected)

Low-confidence machine transcription from `read_audio`; do not quote as exact speech.

- **[00:00–00:15]** "Okay, let's start the goal to main to on the numb and point for the relay gateway. I look at the current fruits right now we have Zashmi one Zashchat andashmi1 Zash or."
- **[00:15–00:24]** "For nobs submission, I slash me one slash relay slashnbs. It keeps everything under one prefix."
- **[00:24–00:34]** "A and the request limit should take 120 requests per minute for now. One more decision, re right."
- **[00:34–00:46]** "Fil no jo and the manlander you after 3 AM. I action item. no write the end point by Friday mail, and I up the knocks."
- **[00:46–00:58]** "Great decision reout, slash me one slash me a slashn, 120 per minute free read right. Thanks."

A slowed (0.75×), filtered re-pass produced the same substance with different garbling — e.g. "slash re one slash relay slash No," "the manlander queue after 3 attempts," and "120 ... free read" — and did not resolve the path segment, queue name, or owner.
