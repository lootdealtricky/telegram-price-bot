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
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    // 1. Exclusion Check
    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    // 2. Link Count Check (Multiple links skip logic)
    const urlMatches = text.match(/https?:\/\/[^\s]+/g); // 'g' flag for all matches
    
    if (!urlMatches || urlMatches.length === 0) return; // कोई लिंक नहीं तो छोड़ो
    
    if (urlMatches.length > 1) {
        console.log(`🚫 Skipping: Post contains ${urlMatches.length} links.`);
        return; // एक से ज्यादा लिंक हैं तो यहीं से वापस (Skip)
    }

    const url = urlMatches[0]; // अब सिर्फ एक ही लिंक है

    // 3. Trigger Logic
    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === ""; 
    const isUrlWithNumbers = /\d+/.test(textWithoutUrl); 

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        console.log(`🎯 Valid Task (Single Link): ${url}`);
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');
        
        db.insert({ url, oldPrice, msgId, chatId, timestamp: Date.now(), isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, Date.now(), isCouponPost);
    }
});

async function monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost) {
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
                await new Promise(r => setTimeout(r, 4000));

                const pageData = await page.evaluate(() => {
                    const priceSelectors = ['.a-price-whole', '._30jeq3', '._25b18c', '.nx-cp0', '.pdp-price', '.price'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el) {
                            foundPrice = parseInt(el.innerText.replace(/\D/g, ''));
                            if (foundPrice) break;
                        }
                    }
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out/i.test(document.body.innerText);
                    return { foundPrice, isOutOfStock, fullText: document.body.innerText.toLowerCase() };
                });

                console.log(`📊 Stats: ${url.substring(0, 15)} | Old: ${oldPrice} | Now: ${pageData.foundPrice} | Stock: ${!pageData.isOutOfStock}`);

                let couponMissing = isCouponPost && !['coupon', 'voucher', 'apply', 'off'].some(k => pageData.fullText.includes(k));

                if (pageData.isOutOfStock || (oldPrice > 0 && pageData.foundPrice > oldPrice * 1.25) || couponMissing) {
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`).catch(() => null);
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Check failed for ${url.substring(0, 15)}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 180000); 
        };
        check();
    } catch (e) {
        console.log("❌ Fatal Browser Error:", e.message);
        if (browser) await browser.close();
    }
}
