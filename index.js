const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply']; 
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
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    
    if (hasTrigger || text.replace(url, '').trim() === "" || /\d+/.test(text)) {
        console.log(`🎯 Valid Task: ${url}`);
        
        // पिनकोड जैसे बड़े नंबर्स को इग्नोर करके असली प्राइस ढूंढना
        const allNumbers = text.match(/\b\d{1,5}\b/g); 
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');
        const isMedia = !!(ctx.channelPost.photo || ctx.channelPost.video || ctx.channelPost.document);

        db.insert({ url, oldPrice, msgId, chatId, originalText: text, isMedia, timestamp: Date.now(), isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, text, isMedia, Date.now(), isCouponPost);
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
                await new Promise(r => setTimeout(r, 5000)); // 5 sec wait for price load

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

                console.log(`📊 Stats: ${url.substring(0, 15)} | Post Price: ${oldPrice} | Live: ${pageData.foundPrice} | Stock: ${!pageData.isOutOfStock}`);

                // Fake Check: सिर्फ तभी ओवर जब प्राइस बढ़े या स्टॉक जाए
                const isOutOfStock = pageData.isOutOfStock;
                const isPriceHigh = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.25));
                
                let couponMissing = false;
                if (isCouponPost) {
                    const couponKeywords = ['coupon', 'voucher', 'apply', 'collect', 'off'];
                    couponMissing = !couponKeywords.some(k => pageData.fullText.includes(k));
                }

                if (isOutOfStock || isPriceHigh || couponMissing) {
                    console.log(`🚨 OVER CONFIRMED: ${url}`);
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
