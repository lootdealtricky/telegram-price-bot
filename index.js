const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = [
  'loot','pincode','reg','available','grab','price','deal',
  'coupon','off','voucher','flat','lowest','apply','discount','free'
];

const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (_, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().then(() => console.log("✅ BOT CONNECTED & READY!"));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urls = text.match(/https?:\/\/[^\s]+/g);
    if (!urls || urls.length !== 1) return;

    const url = urls[0];
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const hasNumbers = /\d+/.test(text);

    if (!(hasTrigger || hasNumbers || text.replace(url, '').trim() === "")) return;

    const nums = text.match(/\b\d{2,5}\b/g);
    const oldPrice = nums ? Math.min(...nums.map(Number)) : 0;

    const isCouponPost = lowerText.includes('coupon') || lowerText.includes('apply');
    const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

    db.insert({
        url, oldPrice, msgId, chatId,
        originalText: text,
        isMedia,
        isCouponPost,
        timestamp: Date.now()
    });

    monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now(), isCouponPost);
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, startTime, isCouponPost) {
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: "new",
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
                db.remove({ msgId }, { multi: true });
                await browser.close();
                return;
            }

            let page;
            try {
                page = await browser.newPage();
                await page.setUserAgent(
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
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

                const priceJump =
                    oldPrice > 0 &&
                    data.price &&
                    data.price >= oldPrice * 1.3 &&
                    !data.coupon;

                const couponMissing = isCouponPost && !data.coupon;

                if (data.outOfStock || priceJump || couponMissing) {
                    const updated =
                      `${originalText}\n\n❌❌ Price Over Now ❌❌\n\nIf you got send screenshot @Ldt_admin_bot`;

                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updated);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updated);
                        }
                    } catch {}

                    db.remove({ msgId }, { multi: true });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log("Retry:", e.message);
            } finally {
                if (page && !page.isClosed()) await page.close();
            }

            setTimeout(check, 180000);
        };

        check();

    } catch (e) {
        if (browser) await browser.close();
    }
}
