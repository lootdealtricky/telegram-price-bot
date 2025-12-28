const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'apple', 'iphone', 'grab', 'bata', 'price', 'reebok', 'adidas', 'puma', 'nike', 'deal', 'lowest', 'coupon', 'freebie'];
const exclusionKeywords = ['guide', 'ajiio.in', 'myntr', 'review', 'sale ended'];

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(PORT, () => console.log(`Server started on ${PORT}`));

// Restart logic
db.find({}, (err, docs) => {
    docs.forEach(doc => {
        if (Date.now() - doc.timestamp < 86400000) {
            monitorPrice(doc.url, doc.oldPrice, doc.msgId, doc.chatId, doc.timestamp);
        } else {
            db.remove({ _id: doc._id });
        }
    });
});

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    // 1. Exclusion Check
    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    // 2. URL Extract
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    // 3. New Trigger Logic (Keyword OR Only URL OR URL + Numbers)
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === "";
    const isUrlWithNumbers = /^\d+$/.test(textWithoutUrl.replace(/[\s₹,]/g, ''));

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;

        const timestamp = Date.now();
        db.insert({ url, oldPrice, msgId, chatId, timestamp });
        monitorPrice(url, oldPrice, msgId, chatId, timestamp);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp) {
    let browser;
    try {
        // Render/Heroku compatibility settings
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const html = await page.content();
                const outOfStock = /Out of Stock|Currently unavailable|Sold Out/i.test(html);

                if (outOfStock || (oldPrice > 0 && currentPrice && currentPrice > oldPrice * 1.20)) {
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`);
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log("Error checking price, retrying...");
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 120000);
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

bot.launch().catch(err => console.error("Bot launch failed:", err));
