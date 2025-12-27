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

    if (url && oldPrice > 5) {
        console.log(`Checking link type for: ${url}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    }
});

// 🕵️ Price Monitor Function with Master Link Filter
async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            let page;
            try {
                page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
                
                // 🛑 Smart Filter: Check if it's a Single Product Page
                const finalUrl = page.url();
                const isSingleProduct = finalUrl.includes('/dp/') || 
                                        finalUrl.includes('/gp/product/') || 
                                        finalUrl.includes('/p/') || 
                                        finalUrl.includes('/buy');

                if (!isSingleProduct) {
                    console.log(`❌ Master Link Detected (${finalUrl}). Stopping monitor.`);
                    await browser.close();
                    return; 
                }

                await new Promise(r => setTimeout(r, 6000));

                // Extract Price
                const currentPrice = await page.evaluate(() => {
                    const selectors = ['.a-price-whole', '.priceToPay', '._30jeq3', '._25b18c', '.nx-cp0'];
                    for (let s of selectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            return parseInt(el.innerText.replace(/\D/g, ''));
                        }
                    }
                    return null;
                });

                const content = await page.content();
                const outOfStock = content.includes("Out of Stock") || 
                                 content.includes("Currently unavailable") || 
                                 content.includes("Sold Out");

                console.log(`Price: ${currentPrice || 'N/A'} | Stock: ${!outOfStock}`);

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `${oldText}\n\nPrice Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("✅ Price Over! Post Edited.");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Check skip/error: " + err.message);
            } finally {
                if (page) await page.close();
            }
            setTimeout(check, 180000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

bot.launch().then(() => console.log("Bot is running..."));
