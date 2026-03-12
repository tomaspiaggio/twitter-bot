# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

X/Twitter reply bot that monitors target accounts and viral tech tweets, generates reply options via Gemini Flash, sends them to Slack for approval, and posts chosen replies via the `bird` CLI. Single TypeScript file (`bot.ts`), long-running process.

## Commands

```bash
npm start          # Run the bot (tsx bot.ts)
npm install        # Install dependencies
```

## Architecture

Everything is in `bot.ts` — single file, no build step. Runs with `tsx` directly.

**Flow:** Poll tweets -> Filter (language, crypto, relevance LLM score) -> Generate 3 reply options (Gemini) -> Post to Slack with buttons -> User picks/regenerates/gives feedback in thread -> Post reply via bird CLI with random delay.

**Two polling loops run on different intervals:**
- Target accounts (`TARGET_ACCOUNTS` array): every 5 min, tweets < 45 min old
- Viral search (rotating keyword queries): every 15 min, tweets < 30 min old, requires 1k+ followers + engagement signal

**Key external dependencies:**
- `bird` CLI — handles all Twitter/X API auth via browser cookies. Use `bird --help` for commands. There's a skill at `.claude/bird/SKILL.md`.
- Slack Bolt (Socket Mode) — no public URL needed. Handles button clicks and thread messages.
- Vercel AI SDK + `@ai-sdk/google` — Gemini 3 Flash for reply generation, Gemini 2.0 Flash for relevance scoring.

**State files (gitignored):**
- `seen_tweets.json` — tracks processed tweet IDs to avoid duplicates across restarts
- `winners.json` — logs chosen replies with tweet context; last 15 are injected into the system prompt as few-shot examples for style learning

**Rate limiting:** bird calls use exponential backoff (30s/60s/120s) on 429s with a global backoff tracker. 3s delay between all API calls.

## Environment Variables

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

## Important Patterns

- `bird()` is async, returns `[ERROR] ...` on failure — callers must check for this prefix
- All bird CLI interaction uses `execFile` (array args, not shell strings) to avoid injection
- Slack message updates use `chat.update` to keep buttons in sync with current options after regeneration
- Thread replies in Slack trigger regeneration with the full conversation history preserved
- The system prompt includes Tom's real tweet examples and winning reply examples — maintain this voice exactly: all lowercase, punchy, builder perspective, never sycophantic
