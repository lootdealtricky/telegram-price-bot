const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

// Database setup
const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// Keywords Setup
const triggerKeywords = ['loot', 'pincode', 'reg', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended'];

// Express Server
const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// Start Bot
bot.launch()
    .then(() => console.log("✅ BOT CONNECTED TO TELEGRAM!"))
    .catch(err => console.error("❌ BOT LAUNCH ERROR:", err));

bot.on('channel_post', async (ctx) => {
    const text = ctx.channelPost.text || "";
    const msgId = ctx.channelPost.message_id;
    const chatId = ctx.chat.id;
    const lowerText = text.toLowerCase().trim();

    if (exclusionKeywords.some(k => lowerText.includes(k))) return;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return;
    const url = urlMatch[0];

    const hasTrigger = triggerKeywords.some(k => lowerText.includes(k));
    const textWithoutUrl = text.replace(url, '').trim();
    const isOnlyUrl = textWithoutUrl === ""; 
    const isUrlWithNumbers = /\d+/.test(textWithoutUrl); 

    if (hasTrigger || isOnlyUrl || isUrlWithNumbers) {
        console.log(`🎯 New Task Received: ${url}`);
        
        const allNumbers = text.match(/\d+/g);
        let oldPrice = allNumbers ? parseInt(allNumbers[allNumbers.length - 1]) : 0;
        
        const isCouponPost = lowerText.includes('coupon') || lowerText.includes('voucher');
        const timestamp = Date.now();
        
        db.insert({ url, oldPrice, msgId, chatId, timestamp, isCouponPost });
        monitorPrice(url, oldPrice, msgId, chatId, timestamp, isCouponPost);
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
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                // Navigate to URL
                console.log(`📡 Checking Page: ${url.substring(0, 40)}...`);
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });

                // Wait for dynamic content
                await new Promise(r => setTimeout(r, 4000));

                const pageData = await page.evaluate(() => {
                    // Extract Price
                    const priceSelectors = ['.a-price-whole', '._30jeq3', '._25b18c', '.nx-cp0', '.pdp-price', '.price-info-price', 'span[price]'];
                    let foundPrice = null;
                    for (let s of priceSelectors) {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            foundPrice = parseInt(el.innerText.replace(/\D/g, ''));
                            if (foundPrice) break;
                        }
                    }

                    // Extract Stock
                    const html = document.body.innerText;
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|stokta yok/i.test(html);

                    return { foundPrice, isOutOfStock, fullText: html.toLowerCase() };
                });

                console.log(`📊 Stats: ${url.substring(0, 20)} | Target: ${oldPrice} | Current: ${pageData.foundPrice} | InStock: ${!pageData.isOutOfStock}`);

                // Coupon check logic
                let couponMissing = false;
                if (isCouponPost) {
                    const couponKeywords = ['coupon', 'voucher', 'apply', 'collect', 'off'];
                    couponMissing = !couponKeywords.some(k => pageData.fullText.includes(k));
                }

                // Decision: When to send "Price Over"
                const priceIncrease = oldPrice > 0 && pageData.foundPrice && pageData.foundPrice > (oldPrice * 1.25);
                
                if (pageData.isOutOfStock || priceIncrease || (isCouponPost && couponMissing)) {
                    console.log(`🚨 CONDITION MET: Price Over for ${url}`);
                    await bot.telegram.editMessageText(chatId, msgId, null, `❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`)
                        .catch(err => console.log("Edit Error (Check Admin Permissions):", err.message));
                    
                    db.remove({ msgId });
                    await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Check Loop Error: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 180000); // 3 Minutes
        };
        check();
    } catch (e) {
        console.log("❌ Fatal Browser Error:", e.message);
        if (browser) await browser.close();
    }
}

// Global Error Handling
bot.catch((err) => console.error("Telegram Global Error:", err));
