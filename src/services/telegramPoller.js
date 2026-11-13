import { stripAndDecodeHtml } from '../utils/textProcessor.js';

export const TELEGRAM_CHANNELS = [
  {
    id: 'n12_telegram',
    name: 'N12 צ\'אט הכתבים (טלגרם)',
    channel: 'N12chat',
    url: 'https://t.me/s/N12chat',
    enabled: true
  },
  {
    id: 'idf_telegram',
    name: 'דובר צה"ל רשמי (טלגרם)',
    channel: 'idfofficial',
    url: 'https://t.me/s/idfofficial',
    enabled: true
  }
];

export class TelegramPoller {
  async fetchChannel(channelName) {
    try {
      const res = await fetch(`https://t.me/s/${channelName}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) return [];
      const html = await res.text();

      const items = [];
      // מחלץ בלוקי הודעות: data-post="channel/id"
      const messageRegex = /<div class="tgme_widget_message_wrap[^>]*>[\s\S]*?data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>[\s\S]*?<time datetime="([^"]+)"/g;

      let match;
      while ((match = messageRegex.exec(html)) !== null) {
        const postId = match[1];
        const rawContent = match[2];
        const datetime = match[3];

        const cleanText = stripAndDecodeHtml(rawContent).replace(/@\w+/g, '').trim();
        if (!cleanText || cleanText.length < 15) continue;

        // הכותרת היא המשפט הראשון או 70 התווים הראשונים
        const firstSentence = cleanText.split(/[.\n!]/)[0].trim();
        const title = firstSentence.length > 10 ? firstSentence : cleanText.slice(0, 80);

        items.push({
          title,
          summary: cleanText,
          url: `https://t.me/${postId}`,
          pubDate: datetime || new Date().toISOString()
        });
      }

      return items;
    } catch (err) {
      return [];
    }
  }
}

export const telegramPoller = new TelegramPoller();
