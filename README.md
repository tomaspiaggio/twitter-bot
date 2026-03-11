# twitter-bot

A small Slack-driven X reply bot.

It polls a curated set of X accounts plus rotating search queries, filters for recent/high-signal tweets, generates three reply options with Gemini, and sends them to Slack for human approval. When you pick a reply, it posts through the `bird` CLI after a random delay.

## What it does

- Polls target accounts every 5 minutes
- Runs viral keyword search every 15 minutes
- Filters out old tweets, low-signal tweets, non English/Spanish content, and crypto spam
- Scores tweet relevance before generating replies
- Sends 3 reply options to Slack
- Supports regenerate, skip, and freeform thread feedback in Slack
- Stores seen tweets and chosen winners locally to avoid repeats and improve future generations

## Requirements

- Node.js
- npm
- A configured `bird` CLI available on your `PATH`
- A Slack app using Socket Mode
- A Google Generative AI API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and fill in real values:

```bash
cp .env.example .env
```

Required variables:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_CHANNEL_ID`
- `GOOGLE_GENERATIVE_AI_API_KEY`

3. Make sure `bird` is authenticated:

```bash
bird whoami --plain
```

## Run

```bash
npm start
```

On startup the bot:

- verifies the `bird` session
- connects to Slack over Socket Mode
- runs an initial target-account poll
- runs an initial viral-search poll
- keeps polling on intervals after that

## Slack workflow

Each candidate tweet is posted to the configured Slack channel with:

- the tweet text and basic engagement stats
- three generated reply options
- buttons for `Pick 1`, `Pick 2`, `Pick 3`, `Regenerate`, and `Skip`

You can also reply in the Slack thread with feedback. The bot will use that thread message as guidance and generate a new set of options.

When you pick a reply, the bot:

- stores the selected reply in `winners.json`
- waits a random amount of time
- posts the reply through `bird`
- marks the tweet as replied in `seen_tweets.json`

## Local files

- `bot.ts`: main bot entrypoint
- `.env.example`: environment variable template
- `seen_tweets.json`: runtime state for handled tweets
- `winners.json`: recent chosen replies used as prompt examples

`seen_tweets.json` and `winners.json` are generated at runtime and are ignored by git.

## Notes

- There is currently no test suite.
- Poll intervals and filtering thresholds are hardcoded in [`bot.ts`](/Users/tompiaggio/Documents/Projects/sandbox/twitter-bot/bot.ts).
