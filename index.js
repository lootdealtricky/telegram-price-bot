const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

// 🔐 Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'grabfast', 'fast', 'lowest'];

// 🌐 Web Server to keep Render alive
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

    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    // URL के सबसे पास वाला Price ढूंढना
    const textBeforeUrl = text.substring(0, text.indexOf(url));
    const allNumbers = textBeforeUrl.match(/\d+/g); 
    
    let oldPrice = null;
    if (allNumbers && allNumbers.length > 0) {
        oldPrice = parseInt(allNumbers[allNumbers.length - 1]);
    }

    if (url && oldPrice) {
        console.log(`Monitoring Started: ${url} | Base Price: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    }
});

// 🕵️ Price Monitor Function
async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const check = async () => {
            let page;
            try {
                page = await browser.newPage();
                // Real user agent to avoid blocking
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
                
                // Wait for price element to appear
                await new Promise(r => setTimeout(r, 6000));

                // Extract price from Amazon or Flipkart
                const currentPrice = await page.evaluate(() => {
                    const selectors = [
                        '.a-price-whole', '.priceToPay', '.apexPriceToPay', // Amazon
                        '._30jeq3', '._25b18c', '.nx-cp0', '.pdp-price',    // Flipkart/Myntra
                        '.product-price', '.css-1j68v7d'                   // Others
                    ];
                    for (let s of selectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            const val = parseInt(el.innerText.replace(/\D/g, ''));
                            if (val > 0) return val;
                        }
                    }
                    return null;
                });

                const content = await page.content();
                const outOfStock = content.includes("Out of Stock") || 
                                 content.includes("Currently unavailable") || 
                                 content.includes("Sold Out") ||
                                 content.includes("यह आइटम अभी उपलब्ध नहीं है");

                console.log(`Checking Result -> Price: ${currentPrice || 'N/A'} | Stock: ${!outOfStock}`);

                // 20% price hike or Out of Stock condition
                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `${oldText}\n\nDeal Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("✅ Message edited successfully!");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Check error (Retrying): " + err.message);
            } finally {
                if (page) await page.close();
            }
            // Check every 2 minutes
            setTimeout(check, 120000); 
        };

        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Fatal Browser Error:", e);
    }
}

// Global error handling to prevent crash
bot.catch((err) => console.error("Telegraf Error:", err));

bot.launch().then(() => console.log("Bot is running..."));
