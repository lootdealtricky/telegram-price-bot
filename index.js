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

bot.launch().then(() => console.log("✅ BOT CONNECTED & READY!"));

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
    const hasNumbers = /\d+/.test(text);

    if (hasTriggerKeyword || hasNumbers || text.replace(url, '').trim() === "") {
        console.log(`🎯 Valid Task: ${url}`);
        
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
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--single-process', 
                '--no-zygote',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setViewport({ width: 1280, height: 800 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                console.log(`🔗 Navigating: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

                const currentUrl = page.url();
                if (currentUrl.includes('lootdealtricky') || currentUrl.includes('linkredirect') || currentUrl.includes('fktr.in')) {
                    console.log("👆 Clicking 'Go to Store'...");
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('a, button'));
                        const target = buttons.find(b => /Go to Store|Visit Retailer|Get Deal|Continue/i.test(b.innerText));
                        if (target) target.click();
                    });
                    await new Promise(r => setTimeout(r, 15000));
                }

                const finalUrl = page.url();
                const isAmazonProduct = finalUrl.includes('/dp/') || finalUrl.includes('/gp/product/');
                const isFlipkartProduct = finalUrl.includes('/p/') || finalUrl.includes('pid=') || finalUrl.includes('/dm/p/');

                if ((finalUrl.includes('amazon.in') && !isAmazonProduct) || (finalUrl.includes('flipkart.com') && !isFlipkartProduct)) {
                    console.log(`⏭️ Masterlink Skipped`);
                    db.remove({ msgId });
                    if (browser) await browser.close();
                    return;
                }

                const pageData = await page.evaluate(() => {
    const priceSelectors = [
        // --- Flipkart New ---
        'div[class*="_30jeq3"]',      // Class containing price
        'div[class*="nx-cp"]',        // New Flipkart price layout
        'div._16Jk6d',                // Flipkart Special Price
        'div._30jeq3._16Jk6d',        // Combined Flipkart selector

        // --- Myntra New ---
        'span.pdp-price',             // Main Price
        'span.pdp-discount-price',    // Discounted Price
        '.pdp-m-price',               // Mobile view price
        'strong.pdp-price',           // Bold price text
        '.css-1j6m64',                // Latest Myntra dynamic class
        
        // --- Amazon (Just in case) ---
        '.a-price-whole', 
        '.priceToPay'
    ];
    
    let foundPrice = null;

    for (let s of priceSelectors) {
        const el = document.querySelector(s);
        if (el && el.innerText) {
            // Price में से ₹, , और अन्य चिन्ह हटाने के लिए
            let p = parseInt(el.innerText.replace(/[^\d]/g, ''));
            if (p > 5) { foundPrice = p; break; }
        }
    }

    // --- Special Myntra Logic (अगर ऊपर वाला काम न करे) ---
    if (!foundPrice && window.location.host.includes('myntra')) {
        const metaPrice = document.querySelector('meta[property="product:price:amount"]');
        if (metaPrice) foundPrice = parseInt(metaPrice.content);
    }

    const bodyText = document.body.innerText;
    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|Abhi upalabdh nahin|not available/i.test(bodyText);
    return { foundPrice, isOutOfStock };
});

                console.log(`📊 Stats: Price Found: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.30));
                const couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                // --- यह हिस्सा अब सही है ---
                if (pageData.isOutOfStock || isPriceIncreased || (isCouponPost && couponMissing && pageData.foundPrice)) {
                    console.log("🚨 DEAL OVER! Updating Message...");
                    const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                    
                    try {
                        if (isMedia) { await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText); }
                        else { await bot.telegram.editMessageText(chatId, msgId, null, updatedText); }
                    } catch (e) { console.log("Edit Error:", e.message); }
                    
                    db.remove({ msgId });
                    if (browser) await browser.close();
                    return;
                }
            } catch (e) {
                console.log(`⚠️ Retry: ${e.message}`);
            } finally {
                if (!page.isClosed()) await page.close();
            }
            setTimeout(check, 200000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}
