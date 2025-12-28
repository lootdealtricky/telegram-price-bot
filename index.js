const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

// Database setup (Updated package for Node 20+)
const db = new Datastore({ filename: 'tasks.db', autoload: true });

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// 🎯 Trigger Keywords
const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apple', 'iphone', 'nike', 'adidas', 'puma', 'reebok']; 

// 🚫 Exclusion Keywords
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// Restart होने पर पुरानी टास्क फिर से शुरू करना
db.find({}, (err, docs) => {
    docs.forEach(doc => {
        const timeElapsed = Date.now() - doc.timestamp;
        if (timeElapsed < 86400000) { 
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
    if (exclusionKeywords.some(k => lowerText.includes(k))) {
        console.log("Exclusion found, skipping.");
        return;
    }

    // 2. URL Match
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    // 3. Multi-Trigger Logic (Keywords, Only URL, or URL + Numbers)
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === "";
    const isUrlWithNumbers = /^\d+$/.test(textWithoutUrl.replace(/[\s₹,]/g, ''));

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        console.log(`Trigger matched for: ${url}`);
        
        // Price ढूंढना (मैसेज का आखिरी नंबर Price माना जाएगा)
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
        // Render के लिए standard launch settings
        browser = await puppeteer.launch({
    headless: "new",
    // Render के लिए ये args बहुत जरूरी हैं
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote'
    ]
});
        
        const check = async () => {
            // 24 घंटे बाद ट्रैकिंग बंद
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId: msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Amazon/Flipkart/Myntra common selectors
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const html = await page.content();
                const outOfStock = /Out of Stock|Currently unavailable|Sold Out|Stokta Yok/i.test(html);

                // Logic: Stock खत्म हो या प्राइस पुराने से 25% बढ़ जाए
                if (outOfStock || (oldPrice > 0 && currentPrice && currentPrice > oldPrice * 1.25)) {
                    const newText = `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    db.remove({ msgId: msgId });
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Monitoring error, retrying in next cycle...");
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 120000); // हर 2 मिनट में चेक
        };
        check();
    } catch (e) {
        console.log("Browser launch failed.");
        if (browser) await browser.close();
    }
}

bot.launch().then(() => console.log("Bot started successfully!"));
