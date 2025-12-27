const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; 
const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    console.log("--- Naya Message Mila! ---");

    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) {
        console.log("Keyword nahi mila, skip kar raha hoon.");
        return;
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const textBeforeUrl = text.substring(0, text.indexOf(url));
    const allNumbers = textBeforeUrl.match(/\d+/g); 
    
    let oldPrice = null;
    if (allNumbers && allNumbers.length > 0) {
        oldPrice = parseInt(allNumbers[allNumbers.length - 1]);
    }

    if (url && oldPrice) {
        console.log(`Monitoring Started: ${url} | Base Price: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId) {
    let browser;
    try {
        // यहाँ बदलाव किया गया है: executablePath हटा दिया गया है
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                // User Agent ताकि Amazon बॉट को न ब्लॉक करे
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable") || html.includes("Sold Out")
                );

                console.log(`Checking: ${currentPrice || 'Price missing'} | Stock: ${!outOfStock}`);

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `Price Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("✅ Message edited successfully!");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Check failed, retrying in 1 mins...");
            } finally {
                await page.close();
            }
            setTimeout(check, 60000); 
        };

        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser Error:", e);
    }
}

bot.launch().then(() => console.log("Bot is running..."));
