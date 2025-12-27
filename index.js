const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('nedb');

// Database setup
const db = new Datastore({ filename: 'tasks.db', autoload: true });

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// 🎯 Trigger Keywords (इन शब्दों के होने पर काम करेगा)
const triggerKeywords = ['loot', 'pincode ', 'reg ', 'Available', 'L O O T ', 'apple ', 'iphone', 'looot ', 'ragular price', 'grab', 'one more', 'pepe', 'bata', 'Asics', 'price', 'reebok', 'adidas', 'puma', 'buy max','selling','nike','deal','lowest','coupon','fast','faaast','freebie','new offer']; 

// 🚫 Exclusion Keywords (इन शब्दों के होने पर बॉट काम नहीं करेगा)
const exclusionKeywords = ['guide', 'ajiio.in', 'myntr', 'charg', 'cable', 'https://lootdealtricky.in/url/', 'breakfast', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// Restart hone par purani tasks shuru karna
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
    const lowerText = text.toLowerCase();

    console.log("--- Naya Message Mila! ---");

    // 1. Exclusion Check (अगर इनमें से कोई शब्द है, तो फौरन रुक जाओ)
    const hasExclusion = exclusionKeywords.some(k => lowerText.includes(k.toLowerCase()));
    if (hasExclusion) {
        console.log("Exclusion keyword mila, skip kar raha hoon.");
        return;
    }

    // 2. Trigger Check (अगर इनमें से कोई शब्द है, तभी आगे बढ़ो)
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k.toLowerCase()));
    if (!hasTrigger) {
        console.log("Koi trigger keyword nahi mila.");
        return;
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const textBeforeUrl = text.substring(0, text.indexOf(url));
    const allNumbers = textBeforeUrl.match(/\d+/g); 
    let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : null;

    if (url && oldPrice) {
        const timestamp = Date.now();
        db.insert({ url, oldPrice, msgId, chatId, timestamp });
        console.log(`Tracking started for 24h: ${url}`);
        monitorPrice(url, oldPrice, msgId, chatId, timestamp);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        
        const check = async () => {
            // 24 ghante check
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId: msgId });
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

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable") || html.includes("Sold Out")
                );

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `Price Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    db.remove({ msgId: msgId });
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Checking failed, retrying...");
            } finally {
                await page.close();
            }
            setTimeout(check, 120000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

bot.launch();

