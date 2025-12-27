const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);
const keywords = ['loot', 'grabfast', 'fast'];

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
    if (!isLoot) return;

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
        console.log(`Monitoring Started: ${url} | Price: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId, text); // यहाँ 'text' भी भेज रहे हैं
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Flipkart/Amazon Price Selectors
                const currentPrice = await page.$eval('.a-price-whole, ._30jeq3, ._25b18c, .nx-cp0', el => 
                    parseInt(el.innerText.replace(/\D/g,''))
                ).catch(() => null);

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable") || html.includes("Sold Out")
                );

                console.log(`Check: ${currentPrice || 'N/A'} | Stock: ${!outOfStock}`);

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    // पुराने टेक्स्ट को बरकरार रखते हुए नीचे मैसेज जोड़ना
                    const newText = `${oldText}\n\nPrice Over Now \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    console.log("✅ Message edited keeping old text!");
                    await browser.close();
                    return; 
                }
            } catch (err) {
                console.log("Retry in 1m...");
            } finally {
                await page.close();
            }
            setTimeout(check, 60000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

bot.launch().then(() => console.log("Bot is running..."));
