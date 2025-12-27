const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');

// Express setup taaki Render bot ko band na kare
const app = express();
app.get('/', (req, res) => res.send('Bot is Active!'));
app.listen(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; 

const bot = new Telegraf(BOT_TOKEN);
const TRIGGER_KEYWORDS = ['loot', 'loooot', 'fast'];

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const messageId = ctx.channelPost.message_id;

    const lowerText = text.toLowerCase();
    const hasKeyword = TRIGGER_KEYWORDS.some(word => lowerText.includes(word));
    
    if (!hasKeyword) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const priceMatch = text.match(/(?:Price|Rs|₹)[:\s]*(\d+)/i);

    if (urlMatch && priceMatch) {
        const url = urlMatch[0];
        const originalPrice = parseFloat(priceMatch[1]);
        monitorPrice(url, originalPrice, messageId, text);
    }
});

async function monitorPrice(url, originalPrice, messageId, oldText) {
    const targetPrice = originalPrice * 1.20; 
    let browser;

    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const data = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '._30jeq3._16Jk6d', '.pdp-price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el) {
                            foundPrice = parseFloat(el.innerText.replace(/[^0-9]/g, ''));
                            break;
                        }
                    }
                    const outOfStock = document.body.innerText.toLowerCase().includes('out of stock') || 
                                     document.body.innerText.toLowerCase().includes('currently unavailable');
                    return { currentPrice: foundPrice, isOutOfStock: outOfStock };
                });

                if (data.isOutOfStock || (data.currentPrice && data.currentPrice >= targetPrice)) {
                    let reason = data.isOutOfStock ? "OUT OF STOCK" : "PRICE UP";
                    const newText = `${oldText}\n\n━━━━━━━━━━━━━━━\n⚠️ ${reason}!\nPrice Over Ho Gaya Hai.\n\nChannel: ${CHANNEL_ID}\nBot: @lootdealtricky bot`;
                    
                    await bot.telegram.editMessageText(CHANNEL_ID, messageId, null, newText);
                    await browser.close();
                    return; 
                }
            } catch (e) { console.log("Retrying..."); }
            finally { if(!page.isClosed()) await page.close(); }
            
            setTimeout(check, 120000); // Har 2 minute mein check karega
        };
        check();
    } catch (err) { console.error(err); }
}

bot.launch();
console.log("Bot started successfully...");
