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

// ... (ऊपर का कोड समान रहेगा)

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
                // मोबाइल एजेंट रीडायरेक्ट को तेज़ करता है
                await page.setViewport({ width: 375, height: 667, isMobile: true });
                await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
                
                console.log(`🔗 Navigating: ${url}`);
                
                // 1. इंतज़ार करें जब तक नेटवर्क शांत न हो जाए (रीडायरेक्ट पूरा होने के लिए)
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });

                // 2. Unshorten Logic: अगर URL अभी भी fkrt.cc या myntr.it है, तो थोड़ा और रुकें
                let finalUrl = page.url();
                if (finalUrl.includes('fkrt.cc') || finalUrl.includes('myntr.it') || finalUrl.includes('fktr.in') || finalUrl.includes('fkrt.it') || finalUrl.includes('lootdealtricky.in/url')) {
                    console.log("⏳ Waiting for unshorten...");
                    await new Promise(r => setTimeout(r, 15000)); 
                    finalUrl = page.url();
                }

                // 3. 'Go to Store' जैसे बटन्स को ऑटो-क्लिक करना
                if (finalUrl.includes('lootdealtricky.in/url') || finalUrl.includes('linkredirect')) {
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('a, button'));
                        const target = buttons.find(b => /Go to Store|Visit Retailer|Get Deal|Continue/i.test(b.innerText));
                        if (target) target.click();
                    });
                    await new Promise(r => setTimeout(r, 15000)); // क्लिक के बाद लोड होने का समय
                    finalUrl = page.url();
                }

                console.log(`✅ Final URL: ${finalUrl.substring(0, 50)}`);

                // 4. Price Extraction (JSON-LD सबसे पक्का तरीका है)
                const pageData = await page.evaluate(() => {
                    let foundPrice = null;

                    // तरीका 1: JSON-LD (सबसे सटीक)
                    try {
                        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                        for (let s of scripts) {
                            const data = JSON.parse(s.innerText);
                            const price = data.offers?.price || data.offers?.lowPrice || (Array.isArray(data.offers) ? data.offers[0]?.price : null);
                            if (price) { foundPrice = parseInt(price); break; }
                        }
                    } catch (e) {}

                    // तरीका 2: Selectors (बैकअप)
                    if (!foundPrice) {
                        const selectors = [
                            'span.pdp-price', 'span.pdp-discount-price', '.pdp-m-price', 
                            'div[class*="_30jeq3"]', 'div._16Jk6d', '.a-price-whole'
                        ];
                        for (let s of selectors) {
                            const el = document.querySelector(s);
                            if (el) {
                                let p = parseInt(el.innerText.replace(/[^\d]/g, ''));
                                if (p > 5) { foundPrice = p; break; }
                            }
                        }
                    }

                    const bodyText = document.body.innerText;
                    const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|Abhi upalabdh nahin/i.test(bodyText);
                    const hasCouponOnPage = /coupon|voucher|apply|promo|collect/i.test(bodyText);
                    
                    return { foundPrice, isOutOfStock, hasCouponOnPage };
                });

                console.log(`📊 Stats: Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                // 5. Deal Over Logic
                const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice && pageData.foundPrice >= (oldPrice * 1.30));
                const couponMissing = isCouponPost && !pageData.hasCouponOnPage;

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
            setTimeout(check, 180000); 
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }

}
