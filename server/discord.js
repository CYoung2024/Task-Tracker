// Delivers reminders as messages from a Discord webhook.
import { getSetting } from './db.js';

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;
const ICONS = { remind: '🔔', overdue: '⚠️', info: '✅' };

export function isValidWebhookUrl(url) {
  return typeof url === 'string' && WEBHOOK_RE.test(url);
}

export function isValidUserId(id) {
  return typeof id === 'string' && /^\d{15,25}$/.test(id);
}

/** Saved setting wins; DISCORD_WEBHOOK_URL is the fallback (handy for Docker). */
export function webhookUrl(db) {
  return getSetting(db, 'discord_webhook_url') || process.env.DISCORD_WEBHOOK_URL || '';
}

export function mentionUserId(db) {
  return getSetting(db, 'discord_user_id') || process.env.DISCORD_USER_ID || '';
}

/**
 * Build the webhook body for a reminder ({title, body, url, kind}). It's all plain message text, not an
 * embed, because phone notifications only show the text: the reminder has to come first so it's what
 * the lock screen shows.
 */
export function discordMessage(n, { userId = '', appUrl = '' } = {}) {
  const lines = [`${ICONS[n.kind] ?? ICONS.info} **${n.title}**`];
  if (n.body) lines.push(n.body);
  // Angle brackets stop Discord from adding a preview card for the link.
  if (appUrl) lines.push(`<${new URL(n.url || '/', appUrl).href}>`);
  // Mentioning you makes Discord notify even if the channel is set to "Only @mentions".
  if (userId) lines[0] += ` <@${userId}>`;
  return {
    username: 'Tasks',
    content: lines.join('\n').slice(0, 2000),
    allowed_mentions: { users: userId ? [userId] : [] },
  };
}

/** Post a reminder to Discord. Throws if it wasn't delivered. */
export async function sendDiscord(db, n) {
  const url = webhookUrl(db);
  if (!url) throw new Error('No Discord webhook is set up');
  const body = JSON.stringify(discordMessage(n, { userId: mentionUserId(db), appUrl: process.env.APP_URL }));

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code ?? err.message);
      throw new Error(`network error (${reason}). Can this server reach discord.com?`);
    }
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      // Rate limited: Discord says how long to wait (seconds).
      const { retry_after = 1 } = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(Number(retry_after) || 1, 10) * 1000));
      continue;
    }
    const detail = await res.text().catch(() => '');
    throw new Error(`Discord returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  throw new Error('Discord kept rate-limiting the webhook');
}
