const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

// 🔐 Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; 
const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

// 🌐 Web Server for Render (24/7 keeping alive)
const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// 📩 Handling Channel Posts
bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    console.log("--- Naya Message Mila! ---");

    // 1. Keyword Check
    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) {
        console.log("Keyword nahi mila, skip kar raha hoon.");
        return;
    }

    // 2. URL Extract karna
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
        console.log("URL nahi mila.");
        return;
    }
    const url = urlMatch[0];

    // 3. URL के सबसे पास वाला Price ढूंढना (URL के पहले का आखिरी नंबर)
    const textBeforeUrl = text.substring(0, text.indexOf(url));
    const allNumbers = textBeforeUrl.match(/\d+/g); 
    
    let oldPrice = null;
    if (allNumbers && allNumbers.length > 0) {
        // URL के सबसे करीब वाला नंबर उठाना
        oldPrice = parseInt(allNumbers[allNumbers.length - 1]);
    }

    if (url && oldPrice) {
        console.log(`Monitoring Started: ${url} | Base Price: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId);
    } else {
        console.log("Price ya URL dhang se nahi mila.");
    }
});

// 🕵️ Price Monitor Function
async function monitorPrice(url, oldPrice, msgId, chatId) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Amazon/Flipkart price selector
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable") || html.includes("Sold Out")
                );

                console.log(`Checking ${url.substring(0,30)}... Current: ${currentPrice} | Stock: ${!outOfStock}`);

                // 20% badhne par ya Stock khatam hone par edit
                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `Price Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("Price Over! Message edited.");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Page check failed, retrying...");
            } finally {
                await page.close();
            }
            setTimeout(check, 120000); // Har 2 minute me check
        };

        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser Error:", e);
    }
}

bot.launch().then(() => console.log("Bot is running..."));
