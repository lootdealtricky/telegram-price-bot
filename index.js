const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const config = require("./config");

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// In-memory tracking
const activeChecks = new Map();

/* -------------------------
   UTIL: Extract URL
-------------------------- */
function extractURL(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

/* -------------------------
   UTIL: Extract Price
-------------------------- */
function extractPrice(text) {
  const match = text.replace(/,/g, "").match(/₹\s?(\d+)/);
  return match ? parseInt(match[1]) : null;
}

/* -------------------------
   SCRAPE PRICE
-------------------------- */
async function fetchCurrentPrice(url) {
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const $ = cheerio.load(res.data);

  // Example: Amazon selector (adjust per site)
  const priceText =
    $("#priceblock_ourprice").text() ||
    $("#priceblock_dealprice").text();

  if (!priceText) {
    return { outOfStock: true };
  }

  const price = parseInt(priceText.replace(/[₹,]/g, ""));
  return { price, outOfStock: false };
}

/* -------------------------
   START PRICE MONITOR
-------------------------- */
function startMonitoring(chatId, messageId, url, basePrice, originalText) {
  const key = `${chatId}_${messageId}`;
  if (activeChecks.has(key)) return;

  const task = cron.schedule(`*/${config.CHECK_INTERVAL_MINUTES} * * * *`, async () => {
    try {
      const data = await fetchCurrentPrice(url);

      if (data.outOfStock) {
        await bot.editMessageText(
          `${originalText}\n\n❌ PRICE BADH GAYA / PRODUCT OUT OF STOCK\n${config.CHANNEL_NAME_TEXT}\n${config.BOT_TAG}`,
          { chat_id: chatId, message_id: messageId }
        );
        task.stop();
        activeChecks.delete(key);
        return;
      }

      const threshold = Math.round(basePrice * (1 + config.PRICE_INCREASE_PERCENT / 100));

      if (data.price >= threshold) {
        await bot.editMessageText(
          `${originalText}\n\n⚠️ PRICE BADH GAYA HAI (₹${data.price})\n${config.CHANNEL_NAME_TEXT}\n${config.BOT_TAG}`,
          { chat_id: chatId, message_id: messageId }
        );
        task.stop();
        activeChecks.delete(key);
      }
    } catch (err) {
      console.error("Price check error:", err.message);
    }
  });

  activeChecks.set(key, task);
}

/* -------------------------
   CHANNEL MESSAGE LISTENER
-------------------------- */
bot.on("channel_post", async msg => {
  if (!msg.text) return;

  const text = msg.text.toLowerCase();
  const triggered = config.TRIGGER_KEYWORDS.some(k => text.includes(k));

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