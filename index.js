// index.js - Notion -> Telegram notifier (time-driven, auto-repeat weekdays)
const axios = require('axios');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // chat id or group id

if (!NOTION_TOKEN || !DATABASE_ID || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing env vars. Required: NOTION_TOKEN, NOTION_DATABASE_ID, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID');
  process.exit(1);
}

// return Lagos weekday short, e.g., "Mon"
function getLagosWeekdayShort(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short' })
    .format(date);
}

// add days to an ISO datetime string, returning new ISO
function addDaysIso(isoStr, days) {
  const dt = new Date(isoStr);
  const newDt = new Date(dt.getTime() + days * 24 * 60 * 60 * 1000);
  return newDt.toISOString();
}

// compute next business day (skip Sat & Sun) preserving clock time
function nextBusinessDayIso(isoStr) {
  // create date in UTC from isoStr, then apply day increments
  let dt = new Date(isoStr);
  // add 1 day until it's Mon-Fri
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(dt.getTime() + i * 24 * 60 * 60 * 1000);
    // get weekday in Lagos to be safe
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short' })
      .format(candidate);
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      return candidate.toISOString();
    }
  }
  // fallback: add 1 day
  return addDaysIso(isoStr, 1);
}

// Query Notion DB for Notify = true and Notify Time <= now
async function notionQuery(nowIso) {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const body = {
    filter: {
      and: [
        { property: "Notify", checkbox: { equals: true } },
        { property: "Notify Time", date: { on_or_before: nowIso } }
      ]
    },
    page_size: 100
  };
  const res = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  return res.data.results || [];
}

function getTitle(props) {
  const t = props?.Name?.title?.[0]?.plain_text;
  return t || 'No title';
}

function getCustomMessage(props) {
  const txt = props?.['Message template']?.rich_text?.[0]?.plain_text;
  return txt || null;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
  return res.data;
}

// Update Notion page: schedule next or disable depending on Repeat
async function scheduleNextOrDisable(pageId, nowIso, props) {
  const repeat = props?.Repeat?.select?.name || 'None';
  const notifyTime = props?.['Notify Time']?.date?.start;

  if (!notifyTime || repeat === 'None') {
    // One-time: unset Notify and set LastSent
    const body = {
      properties: {
        Notify: { checkbox: false },
        LastSent: { date: { start: nowIso } }
      }
    };
    await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, body, {
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      }
    });
    return;
  }

  // For Daily: schedule next business day same clock time (skip weekend)
  let nextIso = nextBusinessDayIso(notifyTime);

  const body = {
    properties: {
      LastSent: { date: { start: nowIso } },
      'Notify Time': { date: { start: nextIso } },
      Notify: { checkbox: true }
    }
  };

  await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, body, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  });
}

(async () => {
  try {
    // now in UTC ISO for Notion filters
    const nowUtcIso = new Date().toISOString();
    const pages = await notionQuery(nowUtcIso);

    if (!pages.length) {
      console.log('No items to notify.');
      return;
    }

    for (const p of pages) {
      const props = p.properties || {};
      const title = getTitle(props);
      const custom = getCustomMessage(props);
      const notifyTime = props?.['Notify Time']?.date?.start || '—';
      const business = props?.Business?.select?.name || '—';

      const message = custom ||
        `Reminder: <b>${title}</b>\nBusiness: ${business}\nTime: ${notifyTime}\n\nThis is an automated reminder.`;

      try {
        await sendTelegram(message);
        console.log('Sent:', title);
        await scheduleNextOrDisable(p.id, nowUtcIso, props);
        console.log('Scheduled next or disabled:', title);
      } catch (err) {
        // Telegram or Notion update failed — log and continue
        console.error('Send/update error for', title, err?.response?.data || err.message || err);
      }
    }
  } catch (err) {
    console.error('Error', err?.response?.data || err.message || err);
    process.exit(1);
  }
})();
