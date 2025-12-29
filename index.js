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
app.get('/', (req, res) => res.send('Bot is Running!'));
app.listen(process.env.PORT || 10000);

bot.launch().catch(err => console.error("Bot launch error:", err));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches) return;
    const url = urlMatches[0];

    // प्राइस निकालने का लॉजिक: पिनकोड को छोड़कर आखिरी नंबर
    const allNumbers = text.match(/\b\d{2,5}\b/g); 
    let oldPrice = 0;
    if (allNumbers) {
        const prices = allNumbers.map(Number).filter(n => n < 100000);
        oldPrice = prices[prices.length - 1];
    }

    console.log(`🎯 New Task: ${url} | Extracted Price: ${oldPrice}`);
    
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
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                // 1. लिंक खोलें (Redirection Bypass)
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 70000 });
                await new Promise(r => setTimeout(r, 8000)); // 8 Sec Wait for Page Load

                // 2. असली यूआरएल क्या है? (Unshortened Link)
                const finalUrl = page.url();
                console.log(`🔗 Unshortened URL: ${finalUrl}`);

                // 3. प्राइस ढूंढें
                const pageData = await page.evaluate(() => {
                    const priceSelectors = [
                        '.a-price-whole', '.priceToPay', '._30jeq3', '.pdp-price', 
                        '.pdp-discount-price', '.price-main-price', '.css-1j6m64', '.pdp-m-price'
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

                console.log(`📊 Stats | Final Link: ${finalUrl.substring(0, 50)}... | Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                // 4. डिसीजन लें
                if (pageData.isOutOfStock || (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.35))) {
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
                console.log(`⚠️ Check Error: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 300000); // 5 मिनट चेकिंग
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

