const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

// Database setup
const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// Keywords & Settings
const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

// Express Server for Render
const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// Bot Start Message
bot.launch().then(() => console.log("✅ BOT CONNECTED TO TELEGRAM!"));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === ""; 
    const isUrlWithNumbers = /\d+/.test(textWithoutUrl); 

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        console.log(`🎯 Tracking started: ${url}`);
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');
        const timestamp = Date.now();
        
        db.insert({ url, oldPrice, msgId, chatId, timestamp, isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });

        const check = async () => {
            // 24 घंटे बाद बंद करें
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                // Redirects को हैंडल करने के लिए networkidle0 का उपयोग
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

                // Amazon/Flipkart/Myntra Selectors
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0, .price', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const html = await page.content();
                const outOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok/i.test(html);

                // Logs में जानकारी दिखाएं
                console.log(`🔎 Checking: ${url.substring(0, 30)}... | Old: ${oldPrice} | Current: ${currentPrice} | Stock: ${outOfStock ? 'NO' : 'YES'}`);

                let couponMissing = false;
                if (isCouponPost) {
                    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
                    couponMissing = !['coupon', 'voucher', 'apply', 'collect', 'off'].some(k => pageText.includes(k));
                }

                // OVER Condition
                if (outOfStock || (oldPrice > 0 && currentPrice && currentPrice > oldPrice * 1.25) || (isCouponPost && couponMissing)) {
                    console.log(`🚨 PRICE OVER for: ${url}`);
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`);
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Link check failed (Wait for retry): ${url.substring(0, 20)}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 120000); // 2 min interval
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

// Error handling for bot
bot.catch((err) => console.error("Telegram Error:", err));
