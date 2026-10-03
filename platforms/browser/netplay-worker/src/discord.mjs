// SPDX-License-Identifier: GPL-3.0-or-later
// The /melee command of the Discord app (Interactions Endpoint URL:
// https://<worker>/discord/interactions). Discord only handles the invite:
// the game runs on the website. /melee picks a room code and answers with a
// public "Join match" link (?join=CODE) and, to the caller only, a "Start
// hosting" link (?online=host&code=CODE), so both land in the same room on
// this Worker.
//
// Every request is verified against the app's public key (DISCORD_PUBLIC_KEY,
// Developer Portal -> General Information) before anything is read from it:
// Discord signs timestamp + body with Ed25519 and refuses an endpoint that
// accepts a bad signature.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const EPHEMERAL = 1 << 6;
const LINK_BUTTON = 5;

const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

/** True when Discord signed exactly this timestamp and body. */
export async function verifyDiscord(request, body, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKey || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const signed = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hex(signature), signed);
  } catch {
    return false;
  }
}

export function newRoomCode() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b & 31]).join('');
}

const showCode = (code) => `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
const linkRow = (...buttons) => [{ type: 1, components: buttons.map(([label, url]) => ({ type: LINK_BUTTON, label, url })) }];

/** The replies to /melee: the public invite and the caller's hosting link. */
export function meleeReplies(interaction, site, code = newRoomCode()) {
  const user = interaction.member?.user ?? interaction.user ?? {};
  const name = user.global_name || user.username || 'Someone';
  const friend = interaction.data?.options?.find((o) => o.name === 'friend')?.value;
  const join = new URL(site);
  join.searchParams.set('join', code);
  const host = new URL(site);
  host.searchParams.set('online', 'host');
  host.searchParams.set('code', code);
  const invite = {
    content: `${friend ? `<@${friend}> ` : ''}**${name}** is hosting a Melee match (code \`${showCode(code)}\`). ` +
      'Open it in Chrome or Edge, then press Join match.',
    allowed_mentions: { users: friend ? [friend] : [] },
    components: linkRow(['Join match', join.href]),
  };
  const hosting = {
    content: 'Your match is ready. Open this, press **Play online**, and wait for your friend:',
    flags: EPHEMERAL,
    components: linkRow(['Start hosting', host.href]),
  };
  return { invite, hosting, code };
}

/** POST /discord/interactions. */
export async function handleInteraction(request, env, ctx) {
  const body = await request.text();
  if (!(await verifyDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
    return new Response('bad request signature', { status: 401 });
  }
  const interaction = JSON.parse(body);
  if (interaction.type === PING) return Response.json({ type: PONG });
  if (interaction.type === APPLICATION_COMMAND && interaction.data?.name === 'melee') {
    if (!env.SITE_URL) {
      return Response.json({ type: CHANNEL_MESSAGE, data: { content: 'No SITE_URL is set for this Worker.', flags: EPHEMERAL } });
    }
    const { invite, hosting } = meleeReplies(interaction, env.SITE_URL);
    // The hosting link goes to the caller alone, as a follow-up once the
    // public reply exists (an interaction answers with one message).
    // DISCORD_API: a local test stands in for discord.com (unset in production).
    const api = env.DISCORD_API || 'https://discord.com/api/v10';
    ctx.waitUntil(fetch(`${api}/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hosting),
    }).catch(() => {}));
    return Response.json({ type: CHANNEL_MESSAGE, data: invite });
  }
  return Response.json({ type: CHANNEL_MESSAGE, data: { content: 'Unknown command.', flags: EPHEMERAL } });
}
