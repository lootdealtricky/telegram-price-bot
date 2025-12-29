const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'deal', 'price', 'coupon', 'off', 'apply', 'lowest']; 
const exclusionKeywords = ['guide', 'review'];

const app = express();
app.get('/', (req, res) => res.send('Bot Status: Active'));
app.listen(process.env.PORT || 10000);

bot.launch().catch(err => console.error("Bot launch error:", err));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches) return;
    const url = urlMatches[0];

    // प्राइस निकालने का बेहतर तरीका: मॉडल नंबरों को छोड़कर सबसे बड़े नंबर के पास वाला छोटा नंबर ढूंढना
    const allNumbers = text.match(/\b\d{2,5}\b/g); 
    // लॉजिक: अगर 'loot' के पास कोई नंबर है या टेक्स्ट का आखिरी नंबर (अगर वह छोटा है)
    let oldPrice = 0;
    if (allNumbers) {
        const prices = allNumbers.map(Number).filter(n => n < 100000); // पिनकोड हटाए
        oldPrice = prices[prices.length - 1]; // आखिरी नंबर को ही प्राइस मानें (आमतौर पर यही होता है)
    }

    console.log(`🎯 Task Received: ${url} | Extracted Price: ${oldPrice}`);
    
    const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video);
    db.insert({ url, oldPrice, msgId, chatId, originalText: text, isMedia, timestamp: Date.now() });
    monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now());
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, timestamp) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const check = async () => {
            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(r => setTimeout(r, 6000)); // 6 सेकंड रुकें ताकि प्राइस लोड हो जाए

                const pageData = await page.evaluate(() => {
                    const priceSelectors = [
                        '.a-price-whole', '.priceToPay', '._30jeq3', '.pdp-price', 
                        '.pdp-discount-price', '.price-main-price', '.css-1j6m64' // Myntra & Flipkart extra selectors
                    ];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 5) { foundPrice = p; break; }
                        }
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|not available|out of stock/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock };
                });

                console.log(`📊 Live Stats | URL: ${url} | Post Price: ${oldPrice} | Found: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                if (pageData.isOutOfStock || (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.35))) {
                    console.log("🚨 DEAL OVER! Updating Telegram...");
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌`;
                    
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) { console.log("Edit Error:", e.message); }
                    
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Error checking ${url}: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 300000); // 5 मिनट में चेक करें
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

