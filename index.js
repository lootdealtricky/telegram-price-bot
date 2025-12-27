const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');

// 🔐 Token aur Channel ID ko hide rakha gaya hai (Render Dashboard se control honge)
const BOT_TOKEN = process.env.BOT_TOKEN;
console.log("Token length check:", BOT_TOKEN ? BOT_TOKEN.length : "Token Missing");
const CHANNEL_ID = process.env.CHANNEL_ID; 

const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    // 1. Keyword Check
    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) return;

    // 2. URL aur Price extract karna
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const priceMatch = text.match(/Price[:\s]*(\d+)/i);
    
    if (urlMatch && priceMatch) {
        const oldPrice = parseInt(priceMatch[1]);
        const url = urlMatch[0];
        console.log(`Monitoring started for: ${url}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        // 🐳 Docker aur Render ke liye optimized Puppeteer settings
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Amazon/Flipkart ke liye price nikalne ka logic
                const currentPrice = await page.$eval('.a-price-whole', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable")
                );

                // 20% Price Badhne ya Out of Stock hone par edit karein
                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    let reason = outOfStock ? "Out of Stock" : "Price Up";
                    const newText = `${oldText}\n\n⚠️ ${reason} ho gaya hai!\n@lootdealtricky bot`;
                    
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    await browser.close();
                    return; // Monitoring Stop
                }
            } catch (err) {
                console.log("Check failed, retrying...");
            } finally {
                await page.close();
            }
            setTimeout(check, 120000); // Har 2 minute me check karega
        };

        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser error:", e);
    }
}

bot.launch().then(() => console.log("Bot is running..."));
