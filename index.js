const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'deal', 'price', 'coupon', 'off', 'apply', 'lowest', 'grab']; 
const exclusionKeywords = ['guide', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().then(() => console.log("✅ BOT CONNECTED!"));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches) return; 

    const url = urlMatches[0];
    const allNumbers = text.match(/\b\d{2,5}\b/g); 
    let oldPrice = allNumbers ? Math.min(...allNumbers.map(Number)) : 0;
    
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
                
                console.log(`🔗 Navigating: ${url}`);
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // **NEW: Affiliate Redirector Bypass**
                // 15-20 second wait taaki affiliate scripts apna kaam kar sakein
                await new Promise(r => setTimeout(r, 20000)); 

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
                            if (p > 10) { foundPrice = p; break; }
                        }
                    }
                    
                    const bodyText = document.body.innerText;
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|not available/i.test(bodyText);
                    return { foundPrice, isOutOfStock, currentUrl: window.location.href };
                });

                console.log(`📊 Result | Final URL: ${pageData.currentUrl.substring(0, 40)}... | Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                // Decision Logic
                if (pageData.foundPrice || pageData.isOutOfStock) {
                    const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice >= (oldPrice * 1.35));
                    
                    if (pageData.isOutOfStock || isPriceIncreased) {
                        const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌`;
                        try {
                            if (isMedia) { await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText); }
                            else { await bot.telegram.editMessageText(chatId, msgId, null, updatedText); }
                        } catch (e) {}
                        db.remove({ msgId });
                        await browser.close();
                        return;
                    }
                }
            } catch (e) {
                console.log(`⚠️ Error: ${e.message}`);
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
