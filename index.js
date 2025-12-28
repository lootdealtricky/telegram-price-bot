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
    const hasTriggerKeyword = triggerKeywords.some(k => lowerText.includes(k));
    
    if (hasTriggerKeyword || text.replace(url, '').trim() === "") {
        console.log(`🎯 Valid Task Found: ${url}`);
        
        // Smart Price Picking: Sabse chhota number lo (aksar wahi loot price hota hai)
        const allNumbers = text.match(/\b\d{2,5}\b/g); 
        let oldPrice = allNumbers ? Math.min(...allNumbers.map(Number)) : 0;
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('apply');
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
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(r => setTimeout(r, 4000));

                const pageData = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '._30jeq3', '._25b18c', '.pdp-price', '.price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            let p = parseInt(el.innerText.replace(/\D/g, ''));
                            if (p > 0) { foundPrice = p; break; }
                        }
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok/i.test(document.body.innerText);
                    const hasCouponOnPage = /coupon|voucher|apply|promo/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock, hasCouponOnPage };
                });

                console.log(`📊 Stats: ${url.substring(0, 20)} | Post Price: ${oldPrice} | Live: ${pageData.foundPrice} | Coupon: ${pageData.hasCouponOnPage}`);

                const isOutOfStock = pageData.isOutOfStock;
                // Price high tabhi maano jab coupon bhi na ho aur price badh jaye
                const isPriceHigh = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.30)) && !pageData.hasCouponOnPage;
                
                // Agar post coupon wali hai toh page par coupon hona chahiye
                let couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                if (isOutOfStock || isPriceHigh || couponMissing) {
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    try {
                        if (isMedia) {
                            await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText);
                        } else {
                            await bot.telegram.editMessageText(chatId, msgId, null, updatedText);
                        }
                    } catch (e) {}
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Error: ${e.message}`);
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
