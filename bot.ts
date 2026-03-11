import "dotenv/config";
import { App } from "@slack/bolt";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);
import { readFileSync, writeFileSync, existsSync } from "fs";

// --- Config ---

const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID!;
const TARGET_POLL_MS = 5 * 60 * 1000; // 5 minutes for target accounts
const SEARCH_POLL_MS = 15 * 60 * 1000; // 15 minutes for viral search
const DELAY_BETWEEN_REQUESTS_MS = 3_000; // 3s between bird API calls to avoid rate limits
const SEEN_FILE = "seen_tweets.json";
const WINNERS_FILE = "winners.json";
const TARGET_MAX_AGE_MS = 45 * 60 * 1000; // 45 min — be early or don't bother
const SEARCH_MAX_AGE_MS = 30 * 60 * 1000; // 30 min for viral discovery
const TARGET_MIN_LIKES = 3; // low bar — these are curated accounts
const RELEVANCE_THRESHOLD = 6; // 1-10, skip below this

// Search queries — NO min_faves, we filter by recency + account size instead
// lang:en OR lang:es appended at search time
const SEARCH_QUERIES = [
  "vibe coding",
  "cursor ai",
  "claude code",
  "ai agents",
  "ai testing",
  "e2e tests",
  "dev tooling",
  "manual QA",
  "AI coding",
  "technical debt",
  "CI CD pipeline",
  "playwright",
  "agentic coding",
  "LLM agents",
  "broken production",
  "shipping fast",
  "code review AI",
  "test automation",
];
let searchQueryIndex = 0;

const TARGET_ACCOUNTS = [
  "t3dotgg",
  "rauchg",
  "mattpocockuk",
  "shadcn",
  "kentcdodds",
  "fireship_dev",
  "ThePrimeagen",
  "swyx",
  "mckaywrigley",
  "cursor_ai",
  "thdxr",
];

const SYSTEM_PROMPT = `you are ghostwriting twitter replies for tom. he's the technical founder/cto of autonoma (ai-powered e2e testing). you need to sound exactly like him — not like an AI pretending to be him.

VOICE — study these real tweets from tom to internalize his style:
- "i don't know if you guys have had the same experience but the only usable models for hard agentic tasks seem to be Opus 4.6 and 5.3 Codex."
- "even if intelligence scores place GLM-5 and Gemini 3 close, they're not even a bit close."
- "public benchmarks are not giving the correct picture."
- "openai acquired openclaw and stayed consistent to their crappy behavior, even if no one is talking about it."
- "today i was talking to someone at vercel, telling them what we do and they said 'oh yeah, i know autonoma'. it felt pretty good."
- "we are THE team to build this."
- "what" (as a reply to something absurd)

RULES:
- everything lowercase. always. no exceptions.
- short. punchy. like texting a friend who's also a developer.
- speak from lived experience as someone building in the trenches, not commenting from the sidelines
- you can be blunt, contrarian, or funny. never mean, never sycophantic.
- no hashtags. no emojis (unless it's genuinely funny, which is rare). no "great point!" or "this is so true!" energy.
- NEVER pitch autonoma. never mention it. the goal is to be interesting enough that people click the profile.
- if the tweet is a shitpost, match shitpost energy. if technical, be technical. read the room.
- replies should feel like they come from someone who ships product every day and has opinions from doing, not reading
- jab jab jab right hook style — add value, share a take, be interesting. don't sell, don't try hard.
- avoid anything that sounds like it was written by chatgpt. no "the irony is", no "this is the way", no corporate speak, no inspirational tone.
- under 200 chars when possible. if it needs more, go up to 280 max.

Output format: Return ONLY a JSON array of exactly 3 reply strings. No explanation, no markdown, no code fences. Example:
["reply one", "reply two", "reply three"]`;

const RELEVANCE_PROMPT = `you are filtering tweets for tom, a technical founder/cto building an ai-powered e2e testing platform.

score this tweet 1-10 for how relevant and valuable it would be for tom to reply to. consider:
- is it about tech, dev tooling, AI, testing, shipping software, or the developer ecosystem?
- is there a natural opening for a sharp, opinionated reply?
- would replying help tom build visibility in the dev community?

score LOW (1-3): personal stuff, anime, food, politics, crypto shilling, generic motivational content
score MEDIUM (4-6): tangentially tech but no natural reply angle, or too niche
score HIGH (7-10): dev tooling hot takes, AI/coding discourse, testing debates, shipping culture, vibe coding discourse

return ONLY a single number 1-10. nothing else.`;

// --- State ---

interface SeenTweets {
  [id: string]: { repliedAt?: string; skippedAt?: string; sentAt?: string };
}

interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  author: { username: string; name: string };
  authorId?: string;
  conversationId?: string;
  followersCount?: number;
  _raw?: any;
}

type ConvoMessage = { role: "user" | "assistant"; content: string };

// In-memory state for pending Slack interactions
const pendingReplies = new Map<
  string,
  {
    tweet: Tweet;
    options: string[];
    slackTs: string;
    conversationHistory: ConvoMessage[];
  }
>();

// --- Helpers ---

function loadSeen(): SeenTweets {
  if (!existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenTweets) {
  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

// --- Winners / learning loop ---

interface Winner {
  tweetAuthor: string;
  tweetText: string;
  chosenReply: string;
  pickedAt: string;
}

function loadWinners(): Winner[] {
  if (!existsSync(WINNERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WINNERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveWinner(winner: Winner) {
  const winners = loadWinners();
  winners.push(winner);
  // Keep last 50 winners to avoid bloating the prompt
  const trimmed = winners.slice(-50);
  writeFileSync(WINNERS_FILE, JSON.stringify(trimmed, null, 2));
}

function buildWinnersContext(): string {
  const winners = loadWinners();
  if (winners.length === 0) return "";

  // Use the most recent 15 for the prompt
  const recent = winners.slice(-15);
  const examples = recent
    .map((w) => `tweet by @${w.tweetAuthor}: "${w.tweetText}"\ntom's reply: "${w.chosenReply}"`)
    .join("\n\n");

  return `\n\nRECENT WINNING REPLIES — these are replies tom actually chose and posted. study the style, tone, and angles that worked:\n\n${examples}`;
}

// Fetch follower count for a tweet's author via bird read --json-full
async function fetchFollowers(tweetId: string): Promise<number> {
  try {
    const raw = await bird(["read", tweetId, "--json-full", "--plain"]);
    if (!raw) return 0;
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) return 0;
    // Sanitize control characters before parsing
    const sanitized = raw.slice(jsonStart).replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );
    const data = JSON.parse(sanitized);
    return data._raw?.core?.user_results?.result?.legacy?.followers_count ?? 0;
  } catch {
    return 0;
  }
}

// Determine if a viral/search tweet is worth replying to
// Returns false for low-quality tweets (small accounts, self-likes, no real traction)
function isWorthReplying(tweet: Tweet, followers: number): { pass: boolean; reason: string } {
  const age = parseTweetAge(tweet.createdAt);
  const ageMinutes = Math.max(age / 60000, 1);

  // Hard minimums — skip tiny accounts entirely
  if (followers < 1000) {
    return { pass: false, reason: `too few followers (${followers})` };
  }

  // For accounts with real reach (10k+), be more lenient on engagement
  // For smaller accounts (1k-10k), require stronger engagement signal
  const likesNeeded = followers >= 10_000 ? 5 : 15;
  if (tweet.likeCount < likesNeeded) {
    return { pass: false, reason: `not enough likes (${tweet.likeCount}/${likesNeeded} needed for ${followers} followers)` };
  }

  // Engagement rate: likes relative to follower count
  // A tweet getting 0.1% engagement in 30 min is solid
  const engagementRate = tweet.likeCount / followers;
  const velocity = tweet.likeCount / ageMinutes;

  // Must meet at least one of these signals:
  // 1. High velocity (>2 likes/min) — blowing up right now
  // 2. Good engagement rate (>0.05%) — resonating with audience
  // 3. Absolute likes (50+) with decent account — already trending
  if (velocity >= 2) {
    return { pass: true, reason: `high velocity (${velocity.toFixed(1)} likes/min)` };
  }
  if (engagementRate >= 0.0005) {
    return { pass: true, reason: `good engagement rate (${(engagementRate * 100).toFixed(2)}%)` };
  }
  if (tweet.likeCount >= 50 && followers >= 5000) {
    return { pass: true, reason: `strong absolute engagement (${tweet.likeCount} likes, ${followers} followers)` };
  }

  return { pass: false, reason: `weak signal (${tweet.likeCount} likes, ${velocity.toFixed(1)}/min, ${(engagementRate * 100).toFixed(3)}% rate, ${followers} followers)` };
}

// Hard skip for crypto/web3 noise
function isCryptoSpam(text: string): boolean {
  return /\b(web3|solana|ethereum|bitcoin|memecoin|airdrop|token launch|nft|defi|wagmi|gm\s*fam|hodl|degen|pump|rug pull|\$[A-Z]{2,6}|0x[a-f0-9]{6,})\b/i.test(text);
}

// Basic latin-script language detection — reject tweets that aren't English or Spanish
// Catches Portuguese, French, German, etc. by looking for common non-EN/ES patterns
function isEnglishOrSpanish(text: string): boolean {
  // Strip URLs and mentions for cleaner detection
  const cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
  if (!cleaned) return true; // empty after cleanup = probably media-only, let it through

  // Portuguese giveaways
  if (/\b(você|não|também|isso|como|então|para|ainda|aqui|muito|mais|está|esse|essa|todo|toda|pode|fazer|voce|nao|tambem|entao|aqui|quando|sobre|pelo|pela|nosso|nossa)\b/i.test(cleaned)) return false;
  // French giveaways
  if (/\b(vous|nous|avec|dans|pour|sont|cette|mais|comme|tout|fait|être|avoir|très|aussi|chez|autre|leurs)\b/i.test(cleaned)) return false;
  // German giveaways
  if (/\b(nicht|sich|auch|noch|werden|haben|diese|wird|sein|dass|nach|einen|diesem|diesem|können)\b/i.test(cleaned)) return false;

  return true;
}

// Track rate limit state globally — when we hit 429, back off everything
let rateLimitBackoffUntil = 0;

async function bird(args: string[], maxRetries = 3): Promise<string> {
  // If we're in a global backoff, wait it out
  const now = Date.now();
  if (rateLimitBackoffUntil > now) {
    const waitMs = rateLimitBackoffUntil - now;
    console.log(`[bird] Global rate limit backoff — waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { stdout, stderr } = await execFile("bird", args, {
        encoding: "utf-8",
        timeout: 30_000,
      });

      // Check stderr for rate limit (bird reports errors there)
      if (stderr && /429|rate limit/i.test(stderr)) {
        const backoff = Math.pow(2, attempt) * 30_000; // 30s, 60s, 120s
        console.warn(`[bird] 429 rate limit (attempt ${attempt + 1}/${maxRetries}), backing off ${Math.round(backoff / 1000)}s`);
        rateLimitBackoffUntil = Date.now() + backoff;
        await sleep(backoff);
        continue;
      }

      if (stderr && /error|failed|denied|unauthorized/i.test(stderr)) {
        console.error(`[bird] Error in stderr: ${stderr.trim()}`);
      }

      return stdout;
    } catch (e: any) {
      const errMsg = e.stderr || e.message || "";

      if (/429|rate limit/i.test(errMsg)) {
        const backoff = Math.pow(2, attempt) * 30_000; // 30s, 60s, 120s
        console.warn(`[bird] 429 rate limit (attempt ${attempt + 1}/${maxRetries}), backing off ${Math.round(backoff / 1000)}s`);
        rateLimitBackoffUntil = Date.now() + backoff;

        if (attempt < maxRetries - 1) {
          await sleep(backoff);
          continue;
        }
      }

      console.error(`[bird] Error running: bird ${args.join(" ")} (attempt ${attempt + 1}/${maxRetries})`);
      console.error(errMsg);

      if (attempt === maxRetries - 1) {
        return `[ERROR] ${errMsg}`;
      }

      // Non-429 errors: short backoff before retry
      await sleep(5_000 * (attempt + 1));
    }
  }
  return "[ERROR] max retries exceeded";
}

function parseTweetAge(createdAt: string): number {
  return Date.now() - new Date(createdAt).getTime();
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomDelay(): number {
  return 30_000 + Math.random() * (5 * 60_000 - 30_000);
}

async function scoreRelevance(tweet: Tweet): Promise<number> {
  try {
    const { text } = await generateText({
      model: google("gemini-2.0-flash"),
      system: RELEVANCE_PROMPT,
      prompt: `@${tweet.author.username}: "${tweet.text}"`,
    });
    const score = parseInt(text.trim());
    return isNaN(score) ? 5 : score;
  } catch {
    return 5; // default to medium on error
  }
}

async function generateReplies(
  tweet: Tweet,
  history: ConvoMessage[]
): Promise<{ options: string[]; history: ConvoMessage[] }> {
  const messages =
    history.length > 0
      ? history
      : [
          {
            role: "user" as const,
            content: `tweet by @${tweet.author.username} (${tweet.likeCount} likes, ${tweet.retweetCount} RTs):\n"${tweet.text}"\n\ngenerate 3 reply options.`,
          },
        ];

  const { text } = await generateText({
    model: google("gemini-3-flash-preview"),
    system: SYSTEM_PROMPT + buildWinnersContext(),
    messages,
  });

  const newHistory = [...messages, { role: "assistant" as const, content: text }];

  try {
    const cleaned = text
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length === 3)
      return { options: parsed, history: newHistory };
  } catch {
    console.error("[ai] Failed to parse reply options:", text);
  }
  return {
    options: ["[generation failed — check logs]", "", ""],
    history: newHistory,
  };
}

// --- Slack helpers ---

function buildOptionBlocks(tweet: Tweet, options: string[]) {
  const age = parseTweetAge(tweet.createdAt);
  const url = `https://x.com/${tweet.author.username}/status/${tweet.id}`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:bird: *New tweet from @${tweet.author.username}* (${tweet.author.name})\n>"${tweet.text}"`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:heart: ${tweet.likeCount}  :recycle: ${tweet.retweetCount}  :speech_balloon: ${tweet.replyCount}  |  ${formatAge(age)}\n${url}`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reply options:*\n\n1\uFE0F\u20E3 ${options[0]}\n\n2\uFE0F\u20E3 ${options[1]}\n\n3\uFE0F\u20E3 ${options[2]}`,
      },
    },
    {
      type: "actions",
      block_id: `tweet_actions_${tweet.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Pick 1" },
          action_id: "pick_1",
          value: tweet.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Pick 2" },
          action_id: "pick_2",
          value: tweet.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Pick 3" },
          action_id: "pick_3",
          value: tweet.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Regenerate" },
          action_id: "regenerate",
          value: tweet.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          action_id: "skip",
          value: tweet.id,
        },
      ],
    },
  ];
}

// --- Slack App ---

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

async function postTweetToSlack(
  tweet: Tweet,
  options: string[],
  conversationHistory: ConvoMessage[]
) {
  const result = await app.client.chat.postMessage({
    channel: SLACK_CHANNEL,
    unfurl_links: false,
    text: `New tweet from @${tweet.author.username}`,
    blocks: buildOptionBlocks(tweet, options),
  });

  if (result.ts) {
    pendingReplies.set(tweet.id, {
      tweet,
      options,
      slackTs: result.ts,
      conversationHistory,
    });
  }
}

// Update the original Slack message with new options (fixes stale button problem)
async function updateSlackMessage(pending: {
  tweet: Tweet;
  options: string[];
  slackTs: string;
}) {
  await app.client.chat.update({
    channel: SLACK_CHANNEL,
    ts: pending.slackTs,
    text: `New tweet from @${pending.tweet.author.username}`,
    blocks: buildOptionBlocks(pending.tweet, pending.options),
  });
}

// Handle button clicks
for (const actionId of [
  "pick_1",
  "pick_2",
  "pick_3",
  "regenerate",
  "skip",
]) {
  app.action(actionId, async ({ action, ack }) => {
    await ack();
    const tweetId = (action as any).value;
    const pending = pendingReplies.get(tweetId);
    if (!pending) return;

    const seen = loadSeen();

    if (actionId === "skip") {
      seen[tweetId] = { skippedAt: new Date().toISOString() };
      saveSeen(seen);
      pendingReplies.delete(tweetId);
      await app.client.chat.postMessage({
        channel: SLACK_CHANNEL,
        thread_ts: pending.slackTs,
        text: ":fast_forward: Skipped.",
      });
      return;
    }

    if (actionId === "regenerate") {
      await app.client.chat.postMessage({
        channel: SLACK_CHANNEL,
        thread_ts: pending.slackTs,
        text: ":arrows_counterclockwise: Regenerating...",
      });

      pending.conversationHistory.push({
        role: "user",
        content:
          "those aren't good enough. generate 3 completely different reply options. try different angles.",
      });
      const { options: newOptions, history } = await generateReplies(
        pending.tweet,
        pending.conversationHistory
      );
      pending.options = newOptions;
      pending.conversationHistory = history;

      // Update the original message so buttons point to current options
      await updateSlackMessage(pending);

      await app.client.chat.postMessage({
        channel: SLACK_CHANNEL,
        thread_ts: pending.slackTs,
        text: `*New options:*\n\n1\uFE0F\u20E3 ${newOptions[0]}\n\n2\uFE0F\u20E3 ${newOptions[1]}\n\n3\uFE0F\u20E3 ${newOptions[2]}`,
      });
      return;
    }

    // Pick 1/2/3
    const idx = parseInt(actionId.split("_")[1]) - 1;
    const chosenReply = pending.options[idx];
    const delay = randomDelay();
    const delayMins = Math.round(delay / 60000);
    const delaySecs = Math.round(delay / 1000);
    const delayLabel = delayMins >= 1 ? `~${delayMins}min` : `~${delaySecs}s`;

    await app.client.chat.postMessage({
      channel: SLACK_CHANNEL,
      thread_ts: pending.slackTs,
      text: `:white_check_mark: Posting in ${delayLabel}...\n>"${chosenReply}"`,
    });

    // Save the winner regardless of whether posting succeeds
    saveWinner({
      tweetAuthor: pending.tweet.author.username,
      tweetText: pending.tweet.text,
      chosenReply,
      pickedAt: new Date().toISOString(),
    });

    // Schedule the actual post with safe shell handling
    setTimeout(async () => {
      try {
        const output = await bird(["reply", tweetId, chosenReply]);

        // Check if bird returned an error
        if (!output || output.startsWith("[ERROR]") || /error|failed|limit|denied|unauthorized/i.test(output)) {
          console.error(`[bird] Reply failed for ${tweetId}:`, output);
          await app.client.chat.postMessage({
            channel: SLACK_CHANNEL,
            thread_ts: pending.slackTs,
            text: `:x: Failed to post reply: ${output.trim().slice(0, 200) || "no output from bird"}`,
          });
          pendingReplies.delete(tweetId);
          return;
        }

        console.log(`[bird] Reply posted to ${tweetId}:`, output);

        seen[tweetId] = {
          repliedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
        };
        saveSeen(seen);

        const url = `https://x.com/${pending.tweet.author.username}/status/${tweetId}`;
        await app.client.chat.postMessage({
          channel: SLACK_CHANNEL,
          thread_ts: pending.slackTs,
          text: `:white_check_mark: Reply posted!\n${url}`,
        });
      } catch (err: any) {
        console.error("[bird] Failed to post reply:", err);
        await app.client.chat.postMessage({
          channel: SLACK_CHANNEL,
          thread_ts: pending.slackTs,
          text: `:x: Failed to post reply: ${err.message?.slice(0, 200) || "unknown error"}`,
        });
      }
      pendingReplies.delete(tweetId);
    }, delay);
  });
}

// Handle thread messages (feedback for regeneration)
app.message(async ({ message, say }) => {
  const msg = message as any;

  // Ignore bot messages to avoid loops
  if (msg.bot_id || msg.subtype === "bot_message") return;

  // Only handle threaded messages
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return;

  console.log(
    `[slack] Thread reply received: "${msg.text?.slice(0, 50)}" in thread ${msg.thread_ts}`
  );

  // Find which pending reply this thread belongs to
  for (const [, pending] of pendingReplies.entries()) {
    if (pending.slackTs === msg.thread_ts) {
      const feedback = msg.text;
      await say({
        text: `:arrows_counterclockwise: Regenerating with feedback...`,
        thread_ts: msg.thread_ts,
      });

      pending.conversationHistory.push({ role: "user", content: feedback });
      const { options: newOptions, history } = await generateReplies(
        pending.tweet,
        pending.conversationHistory
      );
      pending.options = newOptions;
      pending.conversationHistory = history;

      // Update the original message so buttons point to current options
      await updateSlackMessage(pending);

      await say({
        text: `*Updated options:*\n\n1\uFE0F\u20E3 ${newOptions[0]}\n\n2\uFE0F\u20E3 ${newOptions[1]}\n\n3\uFE0F\u20E3 ${newOptions[2]}`,
        thread_ts: msg.thread_ts,
      });
      return;
    }
  }
});

// --- Polling ---

async function pollTargetAccounts() {
  console.log(`[poll] Checking ${TARGET_ACCOUNTS.length} target accounts...`);
  const seen = loadSeen();
  let found = 0;

  for (const handle of TARGET_ACCOUNTS) {
    // If we're deep in rate limit backoff, skip remaining accounts this cycle
    if (rateLimitBackoffUntil > Date.now() + 60_000) {
      console.log(`[poll] Rate limited — skipping remaining accounts this cycle`);
      break;
    }
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
    try {
      const raw = await bird(["user-tweets", handle, "-n", "5", "--json", "--plain"]);
      if (!raw || raw.startsWith("[ERROR]")) continue;

      const jsonStart = raw.indexOf("[");
      if (jsonStart === -1) continue;
      const tweets: Tweet[] = JSON.parse(raw.slice(jsonStart));

      for (const tweet of tweets) {
        if (seen[tweet.id]) continue;
        if (tweet.text.startsWith("RT @")) continue;
        if (!isEnglishOrSpanish(tweet.text)) continue;
        if (isCryptoSpam(tweet.text)) continue;

        const age = parseTweetAge(tweet.createdAt);
        if (age > TARGET_MAX_AGE_MS) continue;
        if (tweet.likeCount < TARGET_MIN_LIKES) continue;

        // Relevance check — skip off-topic tweets
        const score = await scoreRelevance(tweet);
        if (score < RELEVANCE_THRESHOLD) {
          console.log(
            `[poll] Skipping @${handle} tweet (relevance ${score}/10): "${tweet.text.slice(0, 50)}..."`
          );
          seen[tweet.id] = { skippedAt: new Date().toISOString() };
          saveSeen(seen);
          continue;
        }

        seen[tweet.id] = {};
        saveSeen(seen);

        console.log(
          `[poll] Found tweet from @${handle} (relevance ${score}/10): "${tweet.text.slice(0, 60)}..." (${tweet.likeCount} likes, ${formatAge(age)})`
        );

        const { options, history } = await generateReplies(tweet, []);
        await postTweetToSlack(tweet, options, history);
        found++;
      }
    } catch (err) {
      console.error(`[poll] Error fetching @${handle}:`, err);
    }
  }

  console.log(`[poll:targets] Done. Found ${found} new tweets.`);
}

async function pollViralSearch() {
  console.log(`[poll] Running viral search...`);
  const seen = loadSeen();
  let found = 0;

  // Run 3 queries per cycle, rotating through the list
  for (let i = 0; i < 3; i++) {
    const baseQuery = SEARCH_QUERIES[searchQueryIndex % SEARCH_QUERIES.length];
    const query = `${baseQuery} (lang:en OR lang:es)`;
    searchQueryIndex++;

    await sleep(DELAY_BETWEEN_REQUESTS_MS);
    try {
      const raw = await bird(["search", query, "-n", "10", "--json", "--plain"]);
      if (!raw || raw.startsWith("[ERROR]")) continue;

      const jsonStart = raw.indexOf("[");
      if (jsonStart === -1) continue;
      const tweets: Tweet[] = JSON.parse(raw.slice(jsonStart));

      for (const tweet of tweets) {
        if (seen[tweet.id]) continue;
        if (tweet.text.startsWith("RT @")) continue;
        if (isCryptoSpam(tweet.text)) continue;

        // Skip replies — we want original tweets
        if (tweet.conversationId && tweet.conversationId !== tweet.id) continue;

        const age = parseTweetAge(tweet.createdAt);
        if (age > SEARCH_MAX_AGE_MS) continue;

        // Fetch follower count for this tweet's author (individual read, not bulk)
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const followers = await fetchFollowers(tweet.id);

        // Quality gate: check account size + engagement signal
        const { pass, reason } = isWorthReplying(tweet, followers);
        if (!pass) {
          console.log(
            `[poll] Skipping @${tweet.author.username}: ${reason}`
          );
          seen[tweet.id] = { skippedAt: new Date().toISOString() };
          saveSeen(seen);
          continue;
        }

        // Relevance check
        const score = await scoreRelevance(tweet);
        if (score < RELEVANCE_THRESHOLD) {
          seen[tweet.id] = { skippedAt: new Date().toISOString() };
          saveSeen(seen);
          continue;
        }

        seen[tweet.id] = {};
        saveSeen(seen);

        console.log(
          `[poll] Viral tweet from @${tweet.author.username} (${followers} followers, relevance ${score}/10, ${reason}): "${tweet.text.slice(0, 60)}..." (${tweet.likeCount} likes, ${formatAge(age)}) [query: ${baseQuery}]`
        );

        const { options, history } = await generateReplies(tweet, []);
        await postTweetToSlack(tweet, options, history);
        found++;
      }
    } catch (err) {
      console.error(`[poll] Error searching "${baseQuery}":`, err);
    }
  }

  console.log(`[poll:viral] Done. Found ${found} new tweets.`);
}

// --- Main ---

async function main() {
  console.log("[bot] Starting X Reply Bot...");

  const whoami = await bird(["whoami", "--plain"]);
  console.log(`[bird] Logged in as: ${whoami.trim()}`);

  await app.start();
  console.log("[slack] Connected via Socket Mode");

  // Initial polls
  await pollTargetAccounts();
  await pollViralSearch();

  // Target accounts: every 3 minutes (be early)
  setInterval(pollTargetAccounts, TARGET_POLL_MS);
  // Viral search: every 10 minutes
  setInterval(pollViralSearch, SEARCH_POLL_MS);

  console.log(
    `[bot] Target accounts every ${TARGET_POLL_MS / 60000}min, viral search every ${SEARCH_POLL_MS / 60000}min. Waiting for interactions...`
  );
}

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
