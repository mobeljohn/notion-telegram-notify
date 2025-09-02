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

// helper: get current Lagos weekday short (Mon, Tue, ...)
function getLagosWeekdayShort() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short' })
    .format(new Date());
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
    page_size: 50
  };
  const res = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
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

async function updateNotionPage(pageId, nowIso) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const body = {
    properties: {
      Notify: { checkbox: false },
      LastSent: { date: { start: nowIso } }
    }
  };
  await axios.patch(url, body, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  });
}

(async () => {
  try {
    // Use UTC now as ISO for Notion date comparison
    const nowUtcIso = new Date().toISOString();
    const pages = await notionQuery(nowUtcIso);
    const lagosWeekday = getLagosWeekdayShort(); // e.g., "Mon"

    if (!pages.length) {
      console.log('No items to notify.');
      return;
    }

    for (const p of pages) {
      const props = p.properties || {};
      // If Notify Days exists, check if it includes current Lagos weekday
      const days = (props?.['Notify Days']?.multi_select || []).map(s => s.name);
      if (days.length && !days.includes(lagosWeekday)) {
        console.log('Skipping page because weekday not matched:', getTitle(props));
        continue;
      }

      const title = getTitle(props);
      const custom = getCustomMessage(props);
      const notifyTime = props?.['Notify Time']?.date?.start || '—';
      const business = props?.Business?.select?.name || '—';

      const message = custom ||
        `Reminder: <b>${title}</b>\nBusiness: ${business}\nTime: ${notifyTime}\n\nThis is an automated reminder.`;

      await sendTelegram(message);
      await updateNotionPage(p.id, nowUtcIso);
      console.log('Sent and updated:', title);
    }
  } catch (err) {
    console.error('Error', err?.response?.data || err.message || err);
    process.exit(1);
  }
})();
