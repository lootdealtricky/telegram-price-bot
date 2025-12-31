/******************************************************************
 * TELEGRAM PRICE MONITOR BOT – FULL FIXED VERSION
 ******************************************************************/

const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

/* =========================
   ENV VALIDATION
========================= */

if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;

/* =========================
   INIT
========================= */

const bot = new Telegraf(BOT_TOKEN);
const db = new Datastore({ filename: 'tasks.db', autoload: true });

/* =========================
   KEYWORDS
========================= */

const triggerKeywords = [
  'loot','pincode','reg','available','grab','price','deal',
  'coupon','off','voucher','flat','lowest','apply','discount','free'
];

const exclusionKeywords = [
  'guide','ajiio.in','review','sale ended'
];

/* =========================
   EXPRESS (KEEP ALIVE)
========================= */

const app = express();
app.get('/', (_, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

/* =========================
   GLOBAL ERROR SAFETY
========================= */

process.on('unhandledRejection', err => {
  console.error('UNHANDLED:', err);
});

process.on('uncaughtException', err => {
  console.error('UNCAUGHT:', err);
});

/* =========================
   BOT START (NO WEBHOOK CONFLICT)
========================= */

(async () => {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  console.log("✅ BOT CONNECTED & READY!");
})();

/* =========================
   DEBUG: CONFIRM CHANNEL POSTS
========================= */

bot.on('channel_post', ctx => {
  console.log("📩 Channel post received");
});

/* =========================
   MAIN HANDLER
========================= */

bot.on('channel_post', async (ctx) => {

  const text = ctx.channelPost.text || ctx.channelPost.caption || "";
  const msgId = ctx.channelPost.message_id;
  const chatId = ctx.chat.id;
  const lowerText = text.toLowerCase();

  if (!text) return;

  if (exclusionKeywords.some(k => lowerText.includes(k))) return;

  const urls = text.match(/https?:\/\/[^\s]+/g);
  if (!urls || urls.length !== 1) return;

  const url = urls[0];

  const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
  const hasNumbers = /\d+/.test(text);

  if (!(hasTrigger || hasNumbers || text.replace(url, '').trim() === "")) return;

  const numbers = text.match(/\b\d{2,5}\b/g);
  const oldPrice = numbers ? Math.min(...numbers.map(Number)) : 0;

  const isCouponPost = lowerText.includes('coupon') || lowerText.includes('apply');
  const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

  console.log("🎯 Task accepted:", url);

  db.insert({
    url,
    oldPrice,
    msgId,
    chatId,
    originalText: text,
    isMedia,
    isCouponPost,
    timestamp: Date.now()
  });

  monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now(), isCouponPost);
});

/* =========================
   PRICE MONITOR
========================= */

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, startTime, isCouponPost) {

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote'
      ]
    });

    const check = async () => {

      if (Date.now() - startTime > 86400000) {
        console.log("⏰ Task expired");
        db.remove({ msgId }, { multi: true });
        await browser.close();
        return;
      }

      let page;

      try {
        page = await browser.newPage();
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
        );

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
        const finalUrl = page.url();

        const isAmazonProduct =
          finalUrl.includes('/dp/') || finalUrl.includes('/gp/product/');
        const isFlipkartProduct =
          finalUrl.includes('/p/') || finalUrl.includes('pid=');

        if (
          (finalUrl.includes('amazon.in') && !isAmazonProduct) ||
          (finalUrl.includes('flipkart.com') && !isFlipkartProduct)
        ) {
          console.log("⏭️ Masterlink skipped");
          db.remove({ msgId }, { multi: true });
          await browser.close();
          return;
        }

        const data = await page.evaluate(() => {

          const selectors = [
            '.a-price-whole','.priceToPay','.a-offscreen',
            '._30jeq3','._25b18c','.pdp-price','.price'
          ];

          let price = null;

          for (const s of selectors) {
            for (const el of document.querySelectorAll(s)) {
              const v = parseInt(el.innerText.replace(/\D/g, ''));
              if (v > 5) { price = v; break; }
            }
            if (price) break;
          }

          return {
            price,
            outOfStock: /out of stock|currently unavailable|sold out/i.test(document.body.innerText),
            coupon: /coupon|voucher|apply|promo|collect/i.test(document.body.innerText)
          };
        });

        console.log("📊 Live price:", data.price, "Old:", oldPrice);

        const priceJump =
          oldPrice > 0 &&
          data.price &&
          data.price >= oldPrice * 1.3 &&
          !data.coupon;

        const couponMissing = isCouponPost && !data.coupon;

        if (data.outOfStock || priceJump || couponMissing) {

          const updatedText =
`${originalText}

❌❌ Price Over Now ❌❌

If you got screenshot send @Ldt_admin_bot`;

          try {
            if (isMedia) {
              await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
            } else {
              await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
            }
          } catch {}

          db.remove({ msgId }, { multi: true });
          await browser.close();
          return;
        }

      } catch (err) {
        console.log("⚠️ Retry error:", err.message);
      } finally {
        if (page && !page.isClosed()) await page.close();
      }

      setTimeout(check, 180000); // 3 min
    };

    check();

  } catch (err) {
    console.error("❌ Puppeteer failed:", err.message);
    if (browser) await browser.close();
  }
}
