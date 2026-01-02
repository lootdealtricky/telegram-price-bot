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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        });

        const check = async () => {
            if (Date.now() - timestamp > 86400000) {
                db.remove({ msgId });
                if (browser) await browser.close();
                return;
            }

            const page = await browser.newPage();
            try {
                await page.setViewport({ width: 375, height: 667, isMobile: true });
                await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
                
                console.log(`🔗 Navigating: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 }); // networkidle2 बेहतर है

                let finalUrl = page.url();
                let retryUnshort = 0;
                while (retryUnshort < 3 && (finalUrl.includes('fkrt.cc') || finalUrl.includes('myntr.it') || finalUrl.includes('fktr.in') || finalUrl.includes('fkrt.it') || finalUrl.includes('lootdealtricky.in/url') || finalUrl.length < 40)) {
                    console.log(`⏳ Unshortening attempt ${retryUnshort + 1}...`);
                    await new Promise(r => setTimeout(r, 5000)); 
                    await page.evaluate(() => {
                        const btn = Array.from(document.querySelectorAll('a, button')).find(b => /Go to Store|Visit Retailer|Get Deal|Continue/i.test(b.innerText));
                        if (btn) btn.click();
                    });
                    finalUrl = page.url();
                    retryUnshort++;
                }

                console.log(`✅ Fully Loaded URL: ${finalUrl}`);

                const isValidProductPage = finalUrl.includes('/p/') || finalUrl.includes('pid=') || finalUrl.includes('/dp/') || finalUrl.includes('/buy') || finalUrl.includes('/product') || finalUrl.includes('/it/');
                
                if (!isValidProductPage) {
                    console.log("⚠️ URL incomplete/invalid. Waiting for next cycle...");
                } else {
                    // यहाँ हमने evaluate को क्लीन किया है
                    const pageData = await page.evaluate(() => {
                        let foundPrice = null;
                        
                        // 1. JSON-LD Search
                        try {
                            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                            for (let s of scripts) {
                                const data = JSON.parse(s.innerText);
                                const target = Array.isArray(data) ? data[0] : data;
                                const price = target.offers?.price || target.offers?.lowPrice || 
                                              (Array.isArray(target.offers) ? target.offers[0]?.price : null) || target.price;
                                if (price) { foundPrice = parseInt(price); break; }
                            }
                        } catch (e) {}

                        // 2. Class Selectors
                        if (!foundPrice) {
                            const selectors = ['span.pdp-discount-price', 'span.pdp-price', 'div[class*="_30jeq3"]', 'div[class*="_16Jk6d"]', '.nx-cp', '.pdp-m-price', 'span[class*="price"]'];
                            for (let s of selectors) {
                                const el = document.querySelector(s);
                                if (el && el.innerText) {
                                    let p = parseInt(el.innerText.replace(/[^\d]/g, ''));
                                    if (p > 10) { foundPrice = p; break; }
                                }
                            }
                        }

                        const bodyText = document.body.innerText;
                        const isOutOfStock = /Out of Stock|Currently unavailable|Sold Out|Abhi upalabdh nahin|NOT_AVAILABLE|Coming Soon/i.test(bodyText);
                        const hasCouponOnPage = /coupon|voucher|apply|promo|collect/i.test(bodyText);
                        
                        return { foundPrice, isOutOfStock, hasCouponOnPage };
                    });

                    console.log(`📊 Stats: Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                    if (pageData.foundPrice || pageData.isOutOfStock) {
                        const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice >= (oldPrice * 1.30));
                        const couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                        if (pageData.isOutOfStock || isPriceIncreased || (isCouponPost && couponMissing)) {
                            console.log("🚨 DEAL OVER!");
                            const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                            try {
                                if (isMedia) { await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText); }
                                else { await bot.telegram.editMessageText(chatId, msgId, null, updatedText); }
                            } catch (e) { console.log("Edit Error:", e.message); }
                            db.remove({ msgId });
                            if (browser) await browser.close();
                            return;
                        }
                    }
                }
            } catch (e) {
                console.log(`⚠️ Navigation/Logic Error: ${e.message}`);
            } finally {
                if (page && !page.isClosed()) await page.close();
            }
            setTimeout(check, 180000); // 3 मिनट का गैप
        };
        check();
    } catch (e) {
        if (browser) await browser.close();
    }
}

