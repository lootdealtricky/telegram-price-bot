const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb'); // लेटेस्ट पैकेज

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// कूपन वाले कीवर्ड्स यहाँ ऐड कर दिए हैं
const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 10000);

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    // कूपन चेक: अगर टेक्स्ट में 'coupon' या 'off' जैसे शब्द हैं
    const hasCoupon = lowerText.includes('coupon') || lowerText.includes('voucher');
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === "";
    const isUrlWithNumbers = /^\d+$/.test(textWithoutUrl.replace(/[\s₹,]/g, ''));

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers || hasCoupon) {
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;

        db.insert({ url, oldPrice, msgId, chatId, timestamp: Date.now() });
        monitorPrice(url, oldPrice, msgId, chatId, Date.now());
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                // कूपन डिटेक्ट करना (सिर्फ यह देखने के लिए कि क्या कूपन अभी भी मौजूद है)
                const hasCouponOnPage = await page.evaluate(() => {
                    const pageText = document.body.innerText.toLowerCase();
                    return pageText.includes('apply coupon') || pageText.includes('apply voucher') || pageText.includes('collect coupon');
                });

                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const html = await page.content();
                const outOfStock = /Out of Stock|Currently unavailable|Sold Out/i.test(html);

                // अगर स्टॉक खत्म हो जाए OR प्राइस बढ़ जाए
                // (कूपन वाले केस में अगर कूपन गायब हो जाए, तो भी "Over" माना जा सकता है, 
                // लेकिन स्टॉक चेक करना सबसे सटीक है)
                if (outOfStock || (oldPrice > 0 && currentPrice && currentPrice > oldPrice * 1.30)) {
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`);
                    if (browser) await browser.close();
                    return;
                }
            } catch (e) { console.log("Retry..."); }
            finally { if (!page.isClosed()) await page.close(); }
            setTimeout(check, 120000);
        };
        check();
    } catch (e) { if (browser) await browser.close(); }
}
browser = await puppeteer.launch({
    headless: "new",
    executablePath: '/usr/bin/google-chrome', // Docker के लिए जरूरी पाथ
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
});
bot.launch();
