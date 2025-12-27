const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

// Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; 

const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

// 1. Debugging: Check if Bot is starting
console.log("Starting Bot...");
console.log("Target Channel:", CHANNEL_ID);

bot.on('channel_post', async (ctx) => {
    // 2. Debugging: Check every post
    console.log("--- New Post Received in Channel ---");
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    console.log("Post Content:", text);
    console.log("From Chat ID:", chatId);

    // 3. Keyword Check
    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) {
        console.log("Keyword not found. Ignoring.");
        return;
    }

    // 4. URL aur Price extract karna
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const priceMatch = text.match(/Price[:\s]*(\d+)/i);
    
    if (urlMatch && priceMatch) {
        const oldPrice = parseInt(priceMatch[1]);
        const url = urlMatch[0];
        console.log(`✅ Success: Monitoring started for: ${url} at Price: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    } else {
        console.log("❌ Error: Message has keywords but missing Price or URL.");
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                console.log(`Checking price for: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Amazon/Flipkart Logic
                const currentPrice = await page.$eval('.a-price-whole', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable")
                );

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    let reason = outOfStock ? "Out of Stock" : `Price Up (Now: ${currentPrice})`;
                    console.log(`⚠️ Alert: ${reason}. Editing message...`);
                    
                    const newText = `${oldText}\n\n⚠️ ${reason} ho gaya hai!\n@lootdealtricky bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    await browser.close();
                    return; 
                }
                console.log("Price is still okay.");
            } catch (err) {
                console.log("Check failed, retrying in 2 mins...");
            } finally {
                await page.close();
            }
            setTimeout(check, 120000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser error:", e);
    }
}

// 5. Bot Launch with Error Handling
bot.launch()
    .then(() => console.log("🚀 Bot is officially running and listening to channel!"))
    .catch((err) => console.error("Failed to launch bot:", err));

// 6. Web Server for Render
const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
