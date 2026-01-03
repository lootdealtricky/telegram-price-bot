const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer');
const express = require('express');
const Datastore = require('@seald-io/nedb');

const db = new Datastore({ filename: 'tasks.db', autoload: true });
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const triggerKeywords = ['loot', 'pincode', 'available', 'grab', 'price', 'deal', 'coupon', 'off', 'voucher', 'flat', 'lowest', 'apply', 'discount', 'free']; 
const exclusionKeywords = ['guide', 'ajiio.in', 'review', 'sale ended', 'Lootdealtricky.in/url/channels'];

const app = express();
app.get('/', (req, res) => res.send('Bot is Running Live!'));
app.listen(process.env.PORT || 10000);

// Conflict 409 से बचने के लिए Error Handling
bot.launch().catch(err => {
    if (err.description.includes('Conflict')) {
        console.log("⚠️ Conflict detected. Wait, Render will restart correctly.");
    }
});

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
    // ब्राउज़र को लूप के बाहर एक ही बार लॉन्च करें
    let browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });

    const check = async () => {
        // 24 घंटे बाद ट्रैकिंग बंद करें
        if (Date.now() - timestamp > 86400000) {
            db.remove({ msgId }, {}, () => {});
            if (browser) await browser.close();
            return;
        }

        let page;
        try {
            page = await browser.newPage();
            await page.setViewport({ width: 375, height: 667, isMobile: true });
            await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
            
            console.log(`🔗 Navigating: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

            let finalUrl = page.url();
            let retryUnshort = 0;
             while (retryUnshort < 3 && (finalUrl.includes('fkrt.cc') || finalUrl.includes('myntr.it') || finalUrl.includes('fktr.in') || finalUrl.includes('fkrt.it') || finalUrl.includes('lootdealtricky.in/url') || finalUrl.length < 40)) {
                    console.log(`⏳ Unshortening attempt ${retryUnshort + 1}...`);
                await new Promise(r => setTimeout(r, 4000)); 
                await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('a, button')).find(b => /Go to Store|Visit Retailer|Get Deal|Continue/i.test(b.innerText));
                    if (btn) btn.click();
                });
                finalUrl = page.url();
                retryUnshort++;
            }

            const isValidProductPage = finalUrl.includes('/p/') || finalUrl.includes('pid=') || finalUrl.includes('/dp/') || finalUrl.includes('/buy') || finalUrl.includes('/product');
            
            if (isValidProductPage) {
                const pageData = await page.evaluate(() => {
                    let foundPrice = null;
                    try {
                        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                        for (let s of scripts) {
                            const data = JSON.parse(s.innerText);
                            const target = Array.isArray(data) ? data[0] : data;
                            const price = target.offers?.price || target.offers?.lowPrice || (Array.isArray(target.offers) ? target.offers[0]?.price : null) || target.price;
                            if (price) { foundPrice = parseInt(price); break; }
                        }
                    } catch (e) {}

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

                console.log(`📊 Stats [${msgId}]: Price: ${pageData.foundPrice} | OOS: ${pageData.isOutOfStock}`);

                if (pageData.foundPrice || pageData.isOutOfStock) {
                    const isPriceIncreased = (oldPrice > 0 && pageData.foundPrice >= (oldPrice * 1.25)); // 25% वृद्धि पर बंद
                    const couponMissing = isCouponPost && !pageData.hasCouponOnPage;

                    if (pageData.isOutOfStock || isPriceIncreased || (isCouponPost && couponMissing)) {
                        console.log(`🚨 DEAL OVER for ${msgId}`);
                        const updatedText = `${originalText}\n\n❌❌Price Over Now❌❌ \n\nIf you got Send Screenshot me @Ldt_admin_bot`;
                        
                        try {
                            if (isMedia) { await bot.telegram.editMessageCaption(chatId, msgId, null, updatedText); }
                            else { await bot.telegram.editMessageText(chatId, msgId, null, updatedText); }
                        } catch (e) { console.log("Edit Error:", e.message); }
                        
                        db.remove({ msgId }, {}, () => {});
                        if (browser) await browser.close();
                        return;
                    }
                }
            }
        } catch (e) {
            console.log(`⚠️ Log Error [${msgId}]: ${e.message}`);
        } finally {
            if (page) await page.close(); // पेज बंद करना बहुत ज़रूरी है
        }
        
        // अगले चेक के लिए टाइमआउट
        setTimeout(check, 180000); // 3 Minutes
    };
    
    check();
}
