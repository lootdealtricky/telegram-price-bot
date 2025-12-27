const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const keywords = ['loot', 'loooot', 'fast'];

bot.on('channel_post', async (ctx) => {
    console.log("--- New Post Received ---");
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    const isLoot = keywords.some(k => text.toLowerCase().includes(k));
    if (!isLoot) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const priceMatch = text.match(/(?:Price[:\s]*|#Flipkart\s*|#Amazon\s*|Bulb\s*|Rating\s*|Bee\s*)?(\d{2,6})/i);
    
    if (urlMatch && priceMatch) {
        const oldPrice = parseInt(priceMatch[1]);
        const url = urlMatch[0];
        console.log(`✅ Monitoring: ${url} | Price Found: ${oldPrice}`);
        monitorPrice(url, oldPrice, msgId, chatId, text);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, oldText) {
    let browser;
    try {
        // Render के लिए सुधरा हुआ Puppeteer Launch
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/119.0.0.0');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                const currentPrice = await page.evaluate(() => {
                    const el = document.querySelector('.a-price-whole') || document.querySelector('._30jeq3');
                    return el ? parseInt(el.innerText.replace(/\D/g, '')) : null;
                });

                const outOfStock = await page.content().then(html => 
                    html.includes("Out of Stock") || html.includes("Currently unavailable")
                );

                console.log(`Checking: ${currentPrice || 'N/A'}`);

                if (outOfStock || (currentPrice && currentPrice > oldPrice * 1.20)) {
                    const newText = `${oldText}\n\n⚠️ Price Up or Out of Stock!`;
                    await bot.telegram.editMessageText(chatId, msgId, null, newText);
                    await browser.close();
                    return;
                }
            } catch (err) {
                console.log("Check failed, retrying...");
            } finally {
                await page.close();
            }
            setTimeout(check, 180000);
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
        console.error("Browser error:", e.message);
    }
}

bot.launch().then(() => console.log("🚀 Bot is Active!"));

const app = express();
app.get('/', (req, res) => res.send('Bot Live'));
app.listen(process.env.PORT || 10000);
