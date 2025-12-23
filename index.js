/**
 * Telegram Channel Price Monitor Bot
 * Compatible with Hostinger Node.js Hosting
 */

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const config = require("./config");

// ===============================
// BOT INIT
// ===============================
const bot = new TelegramBot(config.BOT_TOKEN, {
  polling: true
});

// Active price check tasks
const activeTasks = new Map();

// ===============================
// UTILS
// ===============================
function extractURL(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function extractPrice(text) {
  const match = text.replace(/,/g, "").match(/₹\s?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ===============================
// PRICE SCRAPER (Amazon example)
// ===============================
async function fetchPrice(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 15000
    });

    const $ = cheerio.load(res.data);

    const priceText =
      $("#priceblock_dealprice").text() ||
      $("#priceblock_ourprice").text();

    if (!priceText) {
      return { outOfStock: true };
    }

    const price = parseInt(priceText.replace(/[₹,]/g, ""), 10);
    return { price, outOfStock: false };
  } catch (err) {
    console.error("Fetch error:", err.message);
    return { error: true };
  }
}

// ===============================
// MONITOR FUNCTION
// ===============================
function startMonitoring(chatId, messageId, url, basePrice, originalText) {
  const taskKey = `${chatId}_${messageId}`;
  if (activeTasks.has(taskKey)) return;

  const thresholdPrice = Math.round(
    basePrice * (1 + config.PRICE_INCREASE_PERCENT / 100)
  );

  const task = cron.schedule(
    `*/${config.CHECK_INTERVAL_MINUTES} * * * *`,
    async () => {
      const data = await fetchPrice(url);

      if (data.outOfStock) {
        await bot.editMessageText(
          `${originalText}\n\n❌ PRICE BADH GAYA / PRODUCT OUT OF STOCK\n${config.CHANNEL_NAME_TEXT}\n${config.BOT_TAG}`,
          {
            chat_id: chatId,
            message_id: messageId,
            disable_web_page_preview: true
          }
        );
        task.stop();
        activeTasks.delete(taskKey);
        return;
      }

      if (data.price && data.price >= thresholdPrice) {
        await bot.editMessageText(
          `${originalText}\n\n⚠️ PRICE BADH GAYA HAI (₹${data.price})\n${config.CHANNEL_NAME_TEXT}\n${config.BOT_TAG}`,
          {
            chat_id: chatId,
            message_id: messageId,
            disable_web_page_preview: true
          }
        );
        task.stop();
        activeTasks.delete(taskKey);
      }
    }
  );

  activeTasks.set(taskKey, task);
}

// ===============================
// CHANNEL LISTENER
// ===============================
bot.on("channel_post", async msg => {
  if (!msg.text) return;

  const textLower = msg.text.toLowerCase();
  const triggered = config.TRIGGER_KEYWORDS.some(k =>
    textLower.includes(k)
  );

  if (!triggered) return;

  const url = extractURL(msg.text);
  const basePrice = extractPrice(msg.text);

  if (!url || !basePrice) return;

  startMonitoring(
    msg.chat.id,
    msg.message_id,
    url,
    basePrice,
    msg.text
  );
});

// ===============================
// START LOG
// ===============================
console.log("Telegram Price Monitor Bot is running...");

