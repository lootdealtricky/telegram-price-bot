const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply', 'discount', 'free']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

bot.launch().then(() => console.log("✅ BOT CONNECTED TO TELEGRAM!"));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || ctx.channelPost.caption || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatches = text.match(/https?:\/\/[^\s]+/g);
    if (!urlMatches || urlMatches.length > 1) return; 

    const url = urlMatches[0];
    
    // --- Naya Logic ---
    const hasTriggerKeyword = triggerKeywords.some(k => lowerText.includes(k));
    const isOnlyUrl = text.replace(url, '').trim() === "";
    
    // Check: Kya link ke ilawa post mein sirf numbers/symbols hain? (Jaise: 99 https://...)
    const textWithoutUrl = text.replace(url, '').replace(/[^\d]/g, '').trim();
    const isOnlyNumbersAndUrl = textWithoutUrl.length > 0 && text.replace(url, '').replace(/[\d\s\W]/g, '').length === 0;

    if (hasTriggerKeyword || isOnlyUrl || isOnlyNumbersAndUrl) {
        console.log(`🎯 Trigger Matched: Starting track for ${url}`);
        
        const allNumbers = text.match(/\b\d{1,5}\b/g); 
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');
        const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

        db.insert({ url, oldPrice, msgId, chatId, originalText: text, isMedia, timestamp: Date.now(), isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now(), isCouponPost);
    } else {
        console.log(`⏭️ Skipping: Neither keywords nor only-numbers found.`);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, originalText, isMedia, timestamp, isCouponPost) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote']
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });
                await new Promise(r => setTimeout(r, 5000));

                const pageData = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '._30jeq3', '._25b18c', '.nx-cp0', '.pdp-price', '.price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 0) { foundPrice = p; break; }
                        }
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock, fullText: document.body.innerText.toLowerCase() };
                });

                console.log(`📊 Stats: ${url.substring(0, 15)} | Old: ${oldPrice} | Now: ${pageData.foundPrice}`);

                const isOutOfStock = pageData.isOutOfStock;
                const isPriceHigh = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.25));
                
                let couponMissing = isCouponPost && !['coupon', 'voucher', 'apply', 'collect', 'off'].some(k => pageData.fullText.includes(k));

                if (isOutOfStock || isPriceHigh || couponMissing) {
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) { console.log("Edit failed:", e.message); }
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Retry: ${url.substring(0, 15)}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 180000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}
