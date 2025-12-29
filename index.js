const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const bot = new Telegraf(process.env.BOT_TOKEN);

const app = express();
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 10000);

bot.launch();

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches) return;

    const url = urlMatches[0];
    const allNumbers = text.match(/\b\d{2,5}\b/g); 
    let oldPrice = allNumbers ? Math.min(...allNumbers.map(Number)) : 0;
    
    const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video);
    db.insert({ url, oldPrice, msgId: ctx.channelPost.message_id, chatId: ctx.chat.id, originalText: text, isMedia, timestamp: Date.now() });
    monitorPrice(url, oldPrice, ctx.channelPost.message_id, ctx.chat.id, text, isMedia, Date.now());
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });

        const check = async () => {
            const page = await browser.newPage();
            // असली इंसान जैसा दिखने के लिए स्क्रीन साइज़
            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            try {
                console.log(`🚀 Opening: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                // **STEP 1: Lootdealtricky Bypass (Button Clicker)**
                if (page.url().includes('lootdealtricky')) {
                    const selectors = ['a.btn', 'button', '.go-to-store', '#btn-main'];
                    for (let s of selectors) {
                        try {
                            await page.click(s);
                            console.log("👆 Button Clicked on Lootdealtricky");
                            await new Promise(r => setTimeout(r, 10000)); // 10s wait for redirect
                            break;
                        } catch (e) {}
                    }
                }

                // **STEP 2: Wait for Redirects to Finish**
                await new Promise(r => setTimeout(r, 15000));
                console.log(`✅ Landed on: ${page.url()}`);

                // **STEP 3: Extract Data with Deep Scan**
                const data = await page.evaluate(() => {
                    const pSelectors = ['.a-price-whole', '._30jeq3', '.pdp-price', '.css-1j6m64', '.pdp-discount-price', '.price-main-price'];
                    let price = null;
                    pSelectors.forEach(s => {
                        const el = document.querySelector(s);
                        if (el && !price) {
                            let val = parseInt(el.innerText.replace(/\D/g, ''));
                            if (val > 10) price = val;
                        }
                    });

                    const oos = /Out of Stock|unavailable|Sold Out|Abhi upalabdh nahin/i.test(document.body.innerText);
                    return { price, oos };
                });

                console.log(`📊 Stats | Price: ${data.price} | OOS: ${data.oos}`);

                if (data.oos || (oldPrice > 0 && data.price >= oldPrice * 1.35)) {
                    const update = `${originalText}\n\n❌❌Price Over Now❌❌`;
                    if (isMedia) await bot.telegram.editMessageCaption(chatId, msgId, null, update);
                    else await bot.telegram.editMessageText(chatId, msgId, null, update);
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (err) {
                console.log("⚠️ Error in loop:", err.message);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 300000);
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}
