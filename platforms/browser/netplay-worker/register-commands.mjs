// SPDX-License-Identifier: GPL-3.0-or-later
// Registers the Discord app's /melee command (src/discord.mjs answers it).
// Run once, and again whenever the command's definition changes:
//
//   DISCORD_BOT_TOKEN=... node register-commands.mjs
//
// The token comes from Developer Portal -> Bot -> Reset Token; it is only sent
// to Discord. The command is user-installable, so it works in servers, DMs and
// group DMs (integration types 0 guild, 1 user; contexts 0 guild, 1 bot DM,
// 2 private channel).
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Set DISCORD_BOT_TOKEN (Developer Portal -> Bot -> Reset Token).');
  process.exit(1);
}

const command = {
  name: 'melee',
  type: 1,
  description: 'Host a Melee match and invite friends to join in their browser',
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [{ type: 6, name: 'friend', description: 'Who to invite (optional)', required: false }],
};

// One command, created or updated by name. A bulk PUT of the whole list would
// have to carry the app's other commands too, including the Activity "Entry
// Point" command Discord adds itself (a PUT without it is refused, 50240).
const response = await fetch(`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`, {
  method: 'POST',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(command),
});
const body = await response.text();
if (!response.ok) {
  console.error(`Discord refused the command: HTTP ${response.status} ${body}`);
  process.exit(1);
}
console.log(`Registered: /${JSON.parse(body).name}`);
